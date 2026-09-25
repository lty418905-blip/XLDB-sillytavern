import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {tokenize} from '../../.local/runtime/node_modules/@lancedb/lancedb/dist/index.js';

export type ChineseTokenizer = 'icu' | 'jieba';

/** Index and query share exactly the same text-token transform. */
export class MemoryTokenizer {
  readonly name: ChineseTokenizer;
  readonly fingerprint: string;
  constructor(name: ChineseTokenizer = 'icu') {
    if(name!=='icu'&&name!=='jieba')throw new Error('invalid_tokenizer');
    this.name=name;
    let dictionary='builtin';
    if(name==='jieba'){
      process.env.LANCE_LANGUAGE_MODEL_HOME ??= fileURLToPath(new URL('../../.local/models/lance-language',import.meta.url));
      const filename=path.join(process.env.LANCE_LANGUAGE_MODEL_HOME,'jieba/default/dict.txt');
      if(!fs.existsSync(filename))throw new Error('jieba_dictionary_missing');
      dictionary=createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
    }
    this.fingerprint=`terms-v1:${name}:${dictionary}`;
  }
  async terms(text:string):Promise<string[]> {
    const tokens=await tokenize(text.normalize('NFKC'),{baseTokenizer:this.name==='jieba'?'jieba/default':'icu',stem:false,removeStopWords:false,asciiFolding:false,maxTokenLength:120});
    // LanceDB 0.39.0's native jieba positions can underflow on overlapping
    // search tokens (e.g. 为什么). Never feed those positions to FTS. Whitespace
    // FTS below reconstructs bounded sequential positions from token TEXT.
    return tokens.map(token=>token.text.toLowerCase()).filter(token=>/[\p{L}\p{N}]/u.test(token));
  }
  async query(text:string):Promise<string>{
    const terms=(await this.terms(text)).filter(term=>!QUERY_FILLERS.has(term));
    // A small language-level equivalence for commitments keeps exact BM25
    // useful without inventing any person, event, or factual answer.
    if(terms.some(term=>['约定','承诺','答应'].includes(term)))terms.push('约定','承诺','答应');
    return [...new Set(terms)].join(' ');
  }
  async document(text:string):Promise<string>{return (await this.terms(text)).join(' ');}
}

// These are question particles, not aliases or invented memories. Meaningful
// names, negatives, numbers and feeling words stay in the query.
const QUERY_FILLERS=new Set(['的','了','呢','吗','是','在','和','与','有','被','对','给','我','你','他','她','它','我们','他们','这个','那个','这次','那次','当时','什么','为什么','为何','怎么','怎样','如何','哪个','哪里','多少','是否','还是','再','又','会','让','后','时']);
