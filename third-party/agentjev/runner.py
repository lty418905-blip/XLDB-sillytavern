"""XLDB offline AgentJev worker. JSON lines over inherited pipes; no network server."""
import argparse
import json
import os
import sys
import time
from pathlib import Path

# The bundled Windows interpreter uses an isolated _pth file.
sys.path.insert(0, str(Path(__file__).resolve().parent))

for key in ('HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE'):
    os.environ[key] = '1'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'


def emit(value):
    print(json.dumps(value, ensure_ascii=False, allow_nan=False), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True)
    parser.add_argument('--threads', type=int, default=4)
    parser.add_argument('--encoding', choices=('path', 'shared'), default='shared')
    parser.add_argument('--diagnostics', action='store_true')
    parser.add_argument('--cast-float32', action='store_true')
    args = parser.parse_args()
    import torch
    from safetensors.torch import load_file
    from transformers import AutoTokenizer
    from agentjev.model import AgentJevModel
    from jev_service.contract import prepare, encode_paths, answer
    from jev_service.prefix import encode
    torch.set_num_threads(max(1, min(args.threads, 8)))
    torch.set_num_interop_threads(1)
    started = time.perf_counter()
    root = Path(args.model)
    tokenizer = AutoTokenizer.from_pretrained(root, local_files_only=True)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    with torch.device('meta'):
        model = AgentJevModel(str(root))
    model.load_state_dict(load_file(str(root / 'model.safetensors')), strict=True, assign=True)
    weight_dtypes = sorted({str(p.dtype) for p in model.parameters() if p.is_floating_point()})
    if not args.cast_float32 and any(parameter.is_floating_point() and parameter.dtype != torch.float32 for parameter in model.parameters()):
        raise RuntimeError('agentjev_unexpected_precision')
    # Qwen's rotary frequencies are non-persistent buffers: safetensors does not
    # populate them when parameters are assigned from a meta construction.
    backbone = model.path_encoder.backbone
    backbone.rotary_emb = type(backbone.rotary_emb)(config=backbone.config)
    if any(tensor.is_meta for tensor in model.buffers()):
        raise RuntimeError('agentjev_uninitialized_buffer')
    if args.cast_float32:
        model.float()
    model.eval()
    # Minimal adapter for the upstream shared-prefix encoder.
    class Engine:
        pass
    engine = Engine()
    engine.torch, engine.device, engine.model = torch, 'cpu', model
    engine.tokenizer, engine.path_batch = tokenizer, 1
    emit({'status': 'ready', 'model': 'agent-jev', 'device': 'cpu',
          'precision': 'float32', 'loadMs': round((time.perf_counter()-started)*1000),
          **({'contract': {'weightDtypes': weight_dtypes, 'runtimeDtype': 'float32',
               'encoding': args.encoding, 'pathBatch': engine.path_batch,
               'hiddenSize': model.hidden_size, 'setHeads': model.set_encoder.encoder.layers[0].self_attn.num_heads,
               'setLayers': len(model.set_encoder.encoder.layers), 'padTokenId': tokenizer.pad_token_id,
               'eosTokenId': tokenizer.eos_token_id, 'maxPathTokens': 2048}}
             if args.diagnostics else {})})
    for line in sys.stdin:
        request_id = None
        try:
            request = json.loads(line)
            request_id = request['id']
            capture_features = request.get('captureFeatures') is True
            prepared = prepare(request['payload'])
            paths, locations, rows = encode_paths(prepared, tokenizer, 2048)
            started = time.perf_counter()
            captured = []
            handle = None
            if capture_features:
                # The exact input to the existing trainable final scorer layer.
                handle = model.scorer.fc2.register_forward_pre_hook(
                    lambda _module, inputs: captured.append(inputs[0].detach()))
            with torch.inference_mode():
                try:
                    vectors, mask, usage = encode(engine, paths, locations, rows, args.encoding)
                    logits = model._score(vectors, mask).float().masked_fill(~mask, float('-inf'))
                    probabilities = torch.softmax(logits, dim=-1).tolist()
                    features = None
                    if capture_features:
                        if len(captured) != 1 or captured[0].shape != (*mask.shape, model.scorer.fc2.in_features):
                            raise RuntimeError('agentjev_feature_shape')
                        reconstructed = model.scorer.fc2(captured[0]).squeeze(-1).float()
                        reconstruction_error = (reconstructed[mask]-logits[mask]).abs().max().item()
                        features = [[captured[0][i,j].float().tolist() for j in range(len(row['candidates']))]
                                    for i,row in enumerate(rows)]
                    diagnostic = None
                    if args.diagnostics:
                        alternative = 'path' if args.encoding == 'shared' else 'shared'
                        other_vectors, other_mask, _ = encode(engine, paths, locations, rows, alternative)
                        other_logits = model._score(other_vectors, other_mask).float()
                        repeat_logits = model._score(vectors, mask).float()
                        diagnostic = {'comparisonEncoding': alternative,
                            'vectorMaxAbsDiff': (vectors-other_vectors).abs().max().item(),
                            'logitMaxAbsDiff': (logits[mask]-other_logits[mask]).abs().max().item(),
                            'headRepeatMaxAbsDiff': (logits[mask]-repeat_logits[mask]).abs().max().item(),
                            'pathLengths': [len(p) for p in paths],
                            'tokenIds': paths,
                            'logits': [logits[i,:len(row['candidates'])].tolist() for i,row in enumerate(rows)]}
                finally:
                    if handle is not None:
                        handle.remove()
            results, offset = [], 0
            for item in prepared:
                answers = []
                for question in item['questions']:
                    answers.append(answer(question, probabilities[offset][:len(question['candidates'])]))
                    offset += 1
                results.append({'id': item['id'], 'answers': answers})
            emit({'id': request_id, 'results': results, 'usage': {**usage, 'generatedTokens': 0,
                  'wallMs': round((time.perf_counter()-started)*1000)},
                  'calibration': 'uncalibrated-companion-domain',
                  **({'learning': [{'features': features[i],
                      'baseLogits': logits[i,:len(row['candidates'])].tolist()}
                      for i,row in enumerate(rows)],
                      'fc2ReconstructionMaxAbsDiff': reconstruction_error} if capture_features else {}),
                  **({'diagnostic': diagnostic} if args.diagnostics else {})})
        except Exception as exc:
            # Neither user text nor exception payloads are echoed to logs.
            emit({'id': request_id, 'error': 'agentjev_context_limit' if isinstance(exc, ValueError)
                  and 'tokens' in str(exc) else 'agentjev_inference_failed'})


if __name__ == '__main__':
    main()
