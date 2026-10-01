import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { connect, Index } from '../../../.local/runtime/node_modules/@lancedb/lancedb/dist/index.js';
import { projectMemories } from './access.ts';
import {retentionSnapshot} from './retention.ts';
import type {SemanticCue} from './retention.ts';
import type { MemorySnapshot, MemoryView, Scope } from './access.ts';
import type { ModelConfig } from '../core/types.ts';
import { scopeKey } from '../core/types.ts';
import {traceModel,withModelAddress,recordModelDispatch,recordModelResponse,recordModelUsage,recordRetrievalFallback} from '../core/runtime-log.ts';
import {MemoryTokenizer} from './tokenizer.ts';
import type {ChineseTokenizer} from './tokenizer.ts';
import {compareSalience} from './vector-forgetting.ts';

const CANDIDATE_LIMIT = 20;
const DEFAULT_EXTERNAL_TIMEOUT_MS = 15_000;
const SEARCH_LIMIT = 40;
const EMBEDDING_BATCH = 32;
// Cosine distance is smaller for a closer match. This is a routing heuristic,
// not a confidence score; callers can tune it for their provider/data.
const DEFAULT_RERANK_COSINE_GAP = 0.08;
const RERANK_POLICY_VERSION = 1;
// Every stored vector is the provider's exact embedding of the row's visible semantic text (ruling 19).
const EXACT_VECTORS = 'float32-exact';

export type RetrievalConfig = { embedding: ModelConfig; reranker: ModelConfig };
type IndexedRow = { id: string; text: string; semantic: string; kind: string; lexical?: string; vector?: number[] };
type RerankResult = { index: number; score: number };
export interface RetrievalOptions {tokenizer?:ChineseTokenizer|'default';minimumRerankScore?:number;rerankCosineGap?:number;externalTimeoutMs?:number;vectorIndex?:'auto'|'flat'}
/**
 * Why an embedding or reranker call failed. credentials_rejected (401/403), model_not_found (404, or a 400/422
 * naming the model) and endpoint_redirected need the user to fix the configuration; the rest are transient.
 */
export type RetrievalFailure='credentials_rejected'|'model_not_found'|'endpoint_redirected'|'rate_limited'|'timeout'|'transport'|'provider_error';
/** Present only when a provider failed and the result came from a lower-quality local path. */
export interface RetrievalDegradation {stage:'embedding'|'reranker';failure:RetrievalFailure;attention:'configuration'|'transient';httpStatus?:number}
type ProviderFallbackReason=`${'embedding'|'rerank'}_${'request_failed'|'credentials_rejected'|'model_not_found'|'endpoint_redirected'}`;
export interface RetrievalResult {ids:string[];mode:string;tokenizer:ChineseTokenizer;intent:'fact'|'episode'|'balanced';cacheHit:boolean;topScore?:number;
  // A transient provider failure keeps the ordinary *_request_failed reason; a credential or configuration failure never does.
  fallbackReason?:ProviderFallbackReason|'pq_index_build_failed';degraded?:RetrievalDegradation;semanticCues?:SemanticCue[];vectorIndex?:'ivf-pq'|'flat'|'none';
  // rerankUsed records an attempted provider call, including an attempted call that failed.
  rerankUsed:boolean;rerankReason:'not_configured'|'no_candidates'|'clear_cosine_gap'|'near_cosine_gap'|'relevant_anchor'|'bm25_no_embedding'|'provider_fallback'}
type Provider = {url:string;key:string;model:string};
type Projection = {fingerprint:string;table:any;index:'ivf-pq'|'flat'|'none';indexFailure?:true;results:Map<string,RetrievalResult>};

/**
 * A disposable LanceDB projection.  It contains only text allowed by the supplied
 * authority snapshot and is never a source of truth: callers recheck returned IDs
 * against the current authority after this async operation.
 */
export class Retrieval {
  private connection: Awaited<ReturnType<typeof connect>> | undefined;
  private readonly tables = new Map<string, Projection>();
  private readonly pending = new Map<string,Promise<void>>();
  private readonly queryVectors = new Map<string,number[]>();
  private readonly directory: string;
  private readonly tokenizer:MemoryTokenizer;
  private readonly minimumRerankScore:number|undefined;
  private readonly rerankCosineGap:number;
  private readonly externalTimeoutMs:number;
  private readonly vectorIndex:'auto'|'flat';

  constructor(directory: string,options:RetrievalOptions={}) {
    this.directory = directory;
    this.tokenizer=new MemoryTokenizer(options.tokenizer==='default'?undefined:options.tokenizer);
    if(options.minimumRerankScore!==undefined&&!Number.isFinite(options.minimumRerankScore))throw new Error('invalid_rerank_threshold');
    if(options.rerankCosineGap!==undefined&&(!Number.isFinite(options.rerankCosineGap)||options.rerankCosineGap<0||options.rerankCosineGap>2))throw new Error('invalid_rerank_cosine_gap');
    if(options.externalTimeoutMs!==undefined&&(!Number.isSafeInteger(options.externalTimeoutMs)||options.externalTimeoutMs<1||options.externalTimeoutMs>30_000))throw new Error('invalid_external_timeout');
    this.minimumRerankScore=options.minimumRerankScore;
    this.rerankCosineGap=options.rerankCosineGap??DEFAULT_RERANK_COSINE_GAP;
    this.externalTimeoutMs=options.externalTimeoutMs??DEFAULT_EXTERNAL_TIMEOUT_MS;
    this.vectorIndex=options.vectorIndex??'auto';
  }

  async search(
    snapshot: MemorySnapshot,
    query: string,
    config: RetrievalConfig,
    nowMs: number,
  ): Promise<RetrievalResult> {
    if (typeof query !== 'string' || query.length > 20_000) throw new Error('invalid_query');
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('invalid_time');
    snapshot=retentionSnapshot(snapshot,nowMs,query);

    const key=scopeKey(snapshot.scope);
    return this.serialized(key,async () => {
      const views = projectMemories(snapshot, {
        scope: snapshot.scope,
        asOfMs: nowMs,
        ids: [...snapshot.memories.keys()],
      }).memories;
      const viewsById=new Map(views.map(view=>[view.id,view]));
      const rows:IndexedRow[] = views.map(view => ({ id: view.id, text: allowedText(view),semantic:semanticText(view),kind:view.kind??'legacy' }))
        .filter(row => row.text.length > 0);
      // Equal scores fall back to one explicit salience order, never to index order or bare id.
      const bySalience=(a:string,b:string)=>{
        const left=viewsById.get(a),right=viewsById.get(b);
        const x=left&&snapshot.memories.get(a),y=right&&snapshot.memories.get(b);
        return x&&y?compareSalience({memory:x,view:left!},{memory:y,view:right!}):x?-1:y?1:0;
      };
      const embedding = configured(config.embedding, 'embedding');
      const reranker = configured(config.reranker, 'reranker');
      const mode = embedding ? 'hybrid' : 'bm25';
      const intent=queryIntent(query);
      const result=(resultMode:string,ids:string[],extra:Partial<RetrievalResult>={}):RetrievalResult=>({ids,mode:resultMode,tokenizer:this.tokenizer.name,intent,cacheHit:false,
        rerankUsed:false,rerankReason:reranker?'no_candidates':'not_configured',...extra});
      if (rows.length === 0) {
        await this.clearProjection(key);
        return result(mode,[]);
      }
      // A protected fact remains stored and searchable, not automatically injected
      // into every unrelated query. An empty query is an explicit recent-memory view.
      if(!query.trim())return result(mode,recentMemoryIds(views));
      const identifiers=query.match(/\b[A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)+\b/g)??[];
      if(identifiers.some(id=>!rows.some(row=>row.text.includes(id))))return result(mode,[]);
      const deadline=Date.now()+this.externalTimeoutMs;
      const run=async(activeEmbedding:Provider|undefined,activeReranker:Provider|undefined,resultMode:string,providerDegradation?:RetrievalDegradation)=>{
        const fallbackReason=providerDegradation&&fallbackReasonOf(providerDegradation);
        const fingerprint = digest(JSON.stringify({
          format:5,vectorIndex:this.vectorIndex==='auto'?'ivf-pq-8bit-256rows-v1':'flat',tokenizer:this.tokenizer.fingerprint,embedding:identity(activeEmbedding),rows,
        }));
        const projection=await this.table(key,fingerprint,rows,activeEmbedding,deadline);
        const table=projection.table;
        const policyRows=views.map(view=>[view.id,view.access,view.anchor,view.protectedFacts,
          snapshot.memories.get(view.id)?.retention?.kind,snapshot.memories.get(view.id)?.accessOverride,
          snapshot.memories.get(view.id)?.source.reference]);
        const cacheKey=digest(JSON.stringify([RERANK_POLICY_VERSION,query,nowMs,snapshot.version,policyRows,
          identity(activeReranker),activeReranker?digest(activeReranker.key):'',activeEmbedding?digest(activeEmbedding.key):'',
          this.minimumRerankScore,this.rerankCosineGap,fallbackReason,providerDegradation?.failure,providerDegradation?.httpStatus]));
        const cached=projection.results.get(cacheKey);
        if(cached){
          // Every degraded search is logged, including one answered from the local fallback cache.
          if(cached.degraded)recordRetrievalFallback(cached.fallbackReason!,cached.degraded);
          return {...cached,ids:[...cached.ids],cacheHit:true,...(cached.degraded?{degraded:{...cached.degraded}}:{})};
        }
        const rowById=new Map(rows.map(row=>[row.id,row]));
        const queries=queryParts(query);
        // Batch the aspect vectors and share the same bounded external deadline.
        if(activeEmbedding)await this.prepareQueryVectors(key,queries,activeEmbedding,deadline);
        const lists=await Promise.all(queries.map(async part=>{
          const lexicalQuery=await this.tokenizer.query(part);
          const [lexical,semantic]=await Promise.all([
            lexicalQuery?table.search(lexicalQuery,'fts','lexical').select(['id','_score']).limit(SEARCH_LIMIT).toArray()
              .then((found:unknown[])=>tieOrdered(found,'_score',bySalience)):[],
            activeEmbedding?this.queryVector(key,part,activeEmbedding,deadline).then(async vector=>{
              let search=table.vectorSearch(vector).column('vector').distanceType('cosine');
              if(projection.index!=='ivf-pq')return tieOrdered(await search.select(['id','_distance']).limit(SEARCH_LIMIT).toArray(),'_distance',bySalience);
              // IVF-PQ only proposes candidates. Threshold-bearing distances are recomputed exactly from the stored
              // float32 vectors, so the gap, rescue and reactivation thresholds see the same scale as a flat scan.
              search=search.nprobes(8).refineFactor(2);
              return tieOrdered(exactDistances(await search.select(['id','vector']).limit(SEARCH_LIMIT).toArray(),vector),'_distance',bySalience);
            }):[],
          ]);
          const ranked=new Map<string,number>();addRanks(ranked,lexical);addRanks(ranked,semantic);
          const candidates=[...ranked.entries()].filter(([id])=>rowById.has(id)).map(([id,score])=>({id,score:score*(intent!=='balanced'&&rowById.get(id)!.kind===intent?1.15:1)}))
            .sort((a,b)=>b.score-a.score||bySalience(a.id,b.id)).slice(0,CANDIDATE_LIMIT).map(item=>item.id);
          const rerankReason=await this.rerankDecision(part,candidates,semantic,activeEmbedding,activeReranker,rowById,viewsById);
          if(rerankReason==='not_configured'||rerankReason==='no_candidates'||rerankReason==='clear_cosine_gap')
            return {ids:candidates,topScore:undefined,semantic,rerankUsed:false,rerankReason};
          let reranked:RerankResult[];
          try{reranked=await rerank(activeReranker!,part,candidates.map(id=>rowById.get(id)!.text),deadline);}
          catch(error){
            const rerankFailed=providerFailure(error);
            if(rerankFailed?.stage!=='reranker')throw error;
            return {ids:candidates,topScore:undefined,rerankFailed,semantic,rerankUsed:true,rerankReason};
          }
          // A provider score is an ordering signal, not a calibrated probability.
          const floor=this.minimumRerankScore??-Infinity;
          return {ids:reranked.filter(item=>item.score>=floor).map(item=>candidates[item.index]),topScore:reranked[0]?.score,semantic,rerankUsed:true,rerankReason};
        }));
        const ids:string[]=[];
        for(let rank=0;rank<CANDIDATE_LIMIT&&ids.length<CANDIDATE_LIMIT;rank++)for(const list of lists){
          const id=list.ids[rank];if(id&&!ids.includes(id)&&ids.length<CANDIDATE_LIMIT)ids.push(id);
        }
        // With several query parts, a configuration failure outranks a transient one so it is never hidden.
        const rerankFailed=lists.map(list=>'rerankFailed' in list?list.rerankFailed:undefined)
          .filter((item):item is RetrievalDegradation=>!!item).sort((a,b)=>failureRank(a)-failureRank(b))[0];
        const degraded=rerankFailed??providerDegradation;
        const rerankUsed=lists.some(list=>list.rerankUsed);
        const rerankReason=fallbackReason?'provider_fallback':lists.find(list=>list.rerankReason==='relevant_anchor')?.rerankReason??
          lists.find(list=>list.rerankReason==='near_cosine_gap')?.rerankReason??
          lists.find(list=>list.rerankReason==='bm25_no_embedding')?.rerankReason??lists[0]?.rerankReason??'no_candidates';
        const semanticCues=activeEmbedding?semanticReactivations(lists[0]?.semantic??[],rowById,viewsById,snapshot,query):[];
        const output=result(rerankFailed?(activeEmbedding?'hybrid-fallback':'bm25-fallback'):rerankUsed?`${resultMode}+rerank`:resultMode,ids,
          {topScore:lists[0]?.topScore,semanticCues,vectorIndex:projection.index,rerankUsed,rerankReason,
            ...(degraded?{fallbackReason:fallbackReasonOf(degraded),degraded:{...degraded}}:projection.indexFailure?{fallbackReason:'pq_index_build_failed' as const}:{})});
        if(!rerankFailed)cache(projection.results,cacheKey,output,64);
        if(output.degraded)recordRetrievalFallback(output.fallbackReason!,output.degraded);
        return {...output,ids:[...output.ids],...(output.degraded?{degraded:{...output.degraded}}:{})};
      };
      try{return await run(embedding,reranker,mode);}
      catch(error){
        const failure=providerFailure(error);
        if(!failure)throw error;
        // Rebuild a text-only projection from this authority snapshot. Failed or
        // partial vectors never enter the projection, and the next search retries
        // the configured provider because its fingerprint differs from this one.
        return run(undefined,undefined,'bm25-fallback',failure);
      }
    });
  }

  close(): void {
    this.connection?.close();
    this.connection = undefined;
    this.tables.clear();
    this.queryVectors.clear();
  }

  async clear(scope: Scope): Promise<void> {
    const key=scopeKey(scope);
    await this.serialized(key,()=>this.clearProjection(key));
  }

  private async table(
    key: string,
    fingerprint: string,
    rows: IndexedRow[],
    embedding: { url: string; key: string; model: string } | undefined,
    deadline: number,
  ): Promise<Projection> {
    const cached=this.tables.get(key);
    if(cached?.fingerprint===fingerprint&&!cached.indexFailure)return cached;
    const name=projectionName(key);
    const metadataPath=path.join(this.directory,`${name}.projection.json`);
    try {
      const database=this.connection??=await connect(this.directory);
      let metadata:{fingerprint?:string;embedding?:string;tokenizer?:string;index?:'ivf-pq'|'flat'|'none';semanticColumn?:boolean;quantizationVersion?:number;vectorEncoding?:string;indexFailure?:boolean}={};
      try{metadata=JSON.parse(fs.readFileSync(metadataPath,'utf8'));}catch{/* Disposable cache, rebuild from authority. */}
      let previous:Awaited<ReturnType<typeof database.openTable>>|undefined;
      try{previous=await database.openTable(name);}catch{/* First projection. */}
      if(previous&&metadata.fingerprint===fingerprint&&!metadata.indexFailure){
        const indices=await previous.listIndices();
        const actual=indices.find(item=>item.columns.includes('vector'));
        if((metadata.index==='ivf-pq'&&actual?.indexType==='IvfPq')||
          (metadata.index!=='ivf-pq'&&!actual)){
          const projection={fingerprint,table:previous,index:metadata.index??'none',results:new Map<string,RetrievalResult>()};cache(this.tables,key,projection,16);return projection;
        }
      }
      const oldRows=new Map<string,IndexedRow&{precisionBits?:number}>();
      if(previous&&metadata.tokenizer&&(metadata.embedding===identity(embedding)||!embedding)){
        // Tables from the pre-semantic projection do not have this column.
        // Their lexical text may be reused, but their old vectors must be
        // recomputed from the current permitted semantic text.
        const columns=embedding?['id','text','lexical','vector']:['id','text','lexical'];
        if(metadata.semanticColumn)columns.push('semantic');
        // A retention-quantized projection (quantizationVersion 1) kept exact vectors only in its 32-bit rows.
        if(metadata.semanticColumn&&metadata.quantizationVersion===1)columns.push('precisionBits');
        const stored=await previous.query().select(columns).toArray();
        for(const row of stored)oldRows.set(row.id,{...row,...(row.vector?{vector:Array.from(row.vector) as number[]}: {})});
      }
      const indexed:IndexedRow[]=[];const missing:number[]=[];
      for(const row of rows){
        const old=oldRows.get(row.id);const same=old?.text===row.text;
        const lexical=same&&metadata.tokenizer===this.tokenizer.fingerprint&&old.lexical!==undefined?old.lexical:await this.tokenizer.document(row.text);
        const exact=metadata.vectorEncoding===EXACT_VECTORS||(metadata.quantizationVersion===1&&old?.precisionBits===32);
        const next={...row,lexical,...(embedding&&same&&old.semantic===row.semantic&&exact&&old.vector?{vector:old.vector}: {})};
        if(embedding&&!next.vector)missing.push(indexed.length);
        indexed.push(next);
      }
      if(embedding)for(let offset=0;offset<missing.length;offset+=EMBEDDING_BATCH){
        const batch=missing.slice(offset,offset+EMBEDDING_BATCH);
        const vectors=await embed(embedding,batch.map(index=>indexed[index].semantic||indexed[index].text),deadline);
        batch.forEach((index,i)=>{indexed[index].vector=vectors[i];});
      }
      // The index is disposable. Remove the old table before publishing a new
      // encoding so a failed rebuild cannot leave a mixed or trusted version.
      if(previous)await database.dropTable(name);
      fs.rmSync(metadataPath,{force:true});
      const table=await database.createTable(name,indexed,{mode:'overwrite'});
      await table.createIndex('lexical',{config:Index.fts({baseTokenizer:'whitespace',stem:false,removeStopWords:false,asciiFolding:false})});
      let index:Projection['index']=embedding?'flat':'none';
      let indexFailure=false;
      const dimension=indexed[0].vector?.length??0;
      if(this.vectorIndex==='auto'&&embedding&&indexed.length>=256&&dimension>=16){
        const numSubVectors=dimension%16===0?dimension/16:dimension%8===0?dimension/8:1;
        try {
          await table.createIndex('vector',{config:Index.ivfPq({distanceType:'cosine',numPartitions:Math.max(1,Math.min(16,Math.floor(Math.sqrt(indexed.length)/8))),numSubVectors,numBits:8})});
          const actual=(await table.listIndices()).find(item=>item.columns.includes('vector'));
          if(actual?.indexType!=='IvfPq'||actual.numIndexedRows!==indexed.length)throw new Error('index_build_failed');
          index='ivf-pq';
        } catch {
          const partial=(await table.listIndices()).find(item=>item.columns.includes('vector'));
          if(partial)await table.dropIndex(partial.name);
          index='flat';
          indexFailure=true;
        }
      }
      fs.mkdirSync(this.directory,{recursive:true});
      const temporary=metadataPath+'.tmp';fs.writeFileSync(temporary,JSON.stringify({fingerprint,embedding:identity(embedding),tokenizer:this.tokenizer.fingerprint,index,semanticColumn:true,vectorEncoding:EXACT_VECTORS,indexFailure}));fs.renameSync(temporary,metadataPath);
      const projection={fingerprint,table,index,...(indexFailure?{indexFailure:true as const}:{}),results:new Map<string,RetrievalResult>()};cache(this.tables,key,projection,16);return projection;
    } catch (error) {
      this.tables.delete(key);
      fs.rmSync(metadataPath,{force:true});
      if (error instanceof Error && (error.message === 'invalid_embedding_response' || error.message === 'embedding_request_failed')) throw error;
      throw new Error('index_build_failed');
    }
  }

  private async queryVector(key:string,query:string,embedding:Provider,deadline:number):Promise<number[]>{
    const id=digest(JSON.stringify([key,query,identity(embedding),digest(embedding.key)]));
    const existing=this.queryVectors.get(id);if(existing)return existing;
    const vector=(await embed(embedding,[query],deadline))[0];cache(this.queryVectors,id,vector,64);return vector;
  }

  private async prepareQueryVectors(key:string,queries:string[],embedding:Provider,deadline:number){
    const missing=queries.map(query=>({query,id:digest(JSON.stringify([key,query,identity(embedding),digest(embedding.key)]))}))
      .filter(item=>!this.queryVectors.has(item.id));
    if(!missing.length)return;
    const vectors=await embed(embedding,missing.map(item=>item.query),deadline);
    missing.forEach((item,index)=>cache(this.queryVectors,item.id,vectors[index],64));
  }

  private async rerankDecision(part:string,candidates:string[],semantic:readonly unknown[],embedding:Provider|undefined,
    reranker:Provider|undefined,rows:Map<string,IndexedRow>,views:Map<string,MemoryView>):Promise<RetrievalResult['rerankReason']>{
    if(!reranker)return 'not_configured';
    if(!candidates.length)return 'no_candidates';
    if(!embedding)return 'bm25_no_embedding';
    const terms=new Set((await this.tokenizer.terms(part)).filter(term=>term.length>=2));
    for(const id of candidates){
      const view=views.get(id);
      if(!view)continue;
      const evidence=[view.anchor,...view.protectedFacts].filter((value):value is string=>typeof value==='string'&&!!value.trim());
      if(!evidence.length)continue;
      for(const phrase of evidence){
        if(phrase.length>=2&&(part.includes(phrase)||phrase.includes(part)))return 'relevant_anchor';
        const evidenceTerms=await this.tokenizer.terms(phrase);
        if(evidenceTerms.some(term=>terms.has(term)))return 'relevant_anchor';
      }
    }
    const distances=semantic.map(item=>record(item)).filter(item=>typeof item.id==='string'&&rows.has(item.id)&&
      typeof item._distance==='number'&&Number.isFinite(item._distance)&&item._distance>=0)
      .map(item=>item._distance as number).sort((a,b)=>a-b);
    return distances.length>=2&&distances[1]-distances[0]<=this.rerankCosineGap?'near_cosine_gap':'clear_cosine_gap';
  }

  private async clearProjection(key:string):Promise<void>{
    this.tables.delete(key);
    this.queryVectors.clear();
    if(!fs.existsSync(this.directory))return;
    const name=projectionName(key);
    const metadataPath=path.join(this.directory,`${name}.projection.json`);
    try {
      const database=this.connection??=await connect(this.directory);
      if((await database.tableNames()).includes(name))await database.dropTable(name);
      fs.rmSync(metadataPath,{force:true});
    } catch {
      throw new Error('retrieval_cleanup_failed');
    }
  }

  private async serialized<T>(key:string,operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(key);
    let release!: () => void;
    const current=new Promise<void>(resolve => { release = resolve; });this.pending.set(key,current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if(this.pending.get(key)===current)this.pending.delete(key);
    }
  }
}

function allowedText(view: MemoryView): string {
  // Remembered fragments are lexical only: semanticText below does not carry them.
  const texts=[view.detail, view.gist, view.feeling, view.anchor, ...(view.rememberedFragments??[]), ...view.protectedFacts,view.episode?.scene,
    ...(view.episode?.participants??[]),...(view.episode?.sensoryCues??[]),view.episode?.appraisal]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  return unique(texts).filter(value=>!texts.some(other=>other.length>value.length&&other.includes(value))).join('\n');
}

function semanticText(view:MemoryView):string {
  // The reactivation vector is built from the current projection, never from
  // faded detail, hidden protected facts, or a source quote kept for audit.
  if(view.access==='gist'||view.access==='feeling'||view.access==='anchor')
    return unique([view.gist,view.feeling,view.anchor].filter((value):value is string=>!!value?.trim())).join('\n');
  return allowedText(view);
}

function semanticReactivations(results:readonly unknown[],rows:Map<string,IndexedRow>,views:Map<string,MemoryView>,
  snapshot:MemorySnapshot,query:string):SemanticCue[] {
  const visible=results.map(item=>record(item)).filter(item=>typeof item.id==='string'&&typeof item._distance==='number'&&
    Number.isFinite(item._distance)&&item._distance>=0).map(item=>({id:item.id as string,distance:item._distance as number}))
    .filter(item=>{
      return !!snapshot.memories.get(item.id)&&!!views.get(item.id)&&!!rows.get(item.id)?.semantic;
    }).sort((a,b)=>a.distance-b.distance);
  const candidates=visible.filter(item=>{
      const memory=snapshot.memories.get(item.id)!,view=views.get(item.id)!;
      return memory.retention?.kind==='peripheral'&&!memory.accessOverride&&
        !memory.source.reference&&(view.access==='gist'||view.access==='feeling');
    });
  if(!candidates.length||candidates[0].distance>0.14)return [];
  const best=candidates[0];
  // Every other visible memory competes for event identity, including a clear
  // or protected memory and a different event extracted from the same source.
  const next=visible.find(item=>item.id!==best.id);
  const margin=next?next.distance-best.distance:2;
  if(margin<0.05)return [];
  return [{id:best.id,cue:query.slice(0,160),basis:rows.get(best.id)!.semantic,distance:best.distance,margin}];
}

/** Cosine distance on the stored float32 values, clamped to the provider-independent [0, 2] range. */
function cosineDistance(left:readonly number[],right:readonly number[]):number {
  let dot=0,a=0,b=0;
  for(let index=0;index<left.length;index++){dot+=left[index]*right[index];a+=left[index]*left[index];b+=right[index]*right[index];}
  if(!a||!b)return 1;
  return Math.min(2,Math.max(0,1-dot/Math.sqrt(a*b)));
}

/** Replaces approximate ANN distances with exact ones; a row without a usable stored vector is not scored. */
function exactDistances(results:readonly unknown[],query:readonly number[]):unknown[] {
  return results.flatMap(item=>{
    const row=record(item),stored=row.vector as ArrayLike<number>|undefined;
    if(typeof row.id!=='string'||!stored||typeof stored.length!=='number'||stored.length!==query.length)return [];
    return [{id:row.id,_distance:cosineDistance(Array.from(stored),query)}];
  });
}

/** Orders by score, and equal scores by the shared salience order instead of the index's arbitrary order. */
function tieOrdered(results:readonly unknown[],field:'_score'|'_distance',compare:(a:string,b:string)=>number):unknown[] {
  const value=(item:unknown)=>{const found=record(item)[field];
    return typeof found==='number'&&Number.isFinite(found)?found:field==='_score'?-Infinity:Infinity;};
  const id=(item:unknown)=>{const found=record(item).id;return typeof found==='string'?found:'';};
  return [...results].sort((a,b)=>(field==='_score'?value(b)-value(a):value(a)-value(b))||compare(id(a),id(b)));
}

function recentMemoryIds(views: readonly MemoryView[]): string[] {
  return [...views]
    .sort((a, b) => (b.source.occurredAtMs??b.source.knownAtMs) - (a.source.occurredAtMs??a.source.knownAtMs) || b.source.knownAtMs - a.source.knownAtMs)
    .map(view => view.id)
    .slice(0, CANDIDATE_LIMIT);
}

function addRanks(ranked: Map<string, number>, results: readonly unknown[]): void {
  for (let index = 0; index < results.length; index++) {
    const id = record(results[index]).id;
    if (typeof id !== 'string') continue;
    ranked.set(id, (ranked.get(id) ?? 0) + 1 / (60 + index + 1));
  }
}

function queryIntent(query:string):RetrievalResult['intent']{
  if(/感受|感觉|想起|回忆|为何|为什么|怎么想|安心|紧张|害怕|失望|高兴|敬佩|看法|安全感|和解|理解|怎样|如何/.test(query))return 'episode';
  if(/多少|几点|编号|号码|金额|口令|约定|承诺|身份|日期|库存|由谁|是谁|哪位|哪页|颜色/.test(query))return 'fact';
  return 'balanced';
}

/** Split explicit lists, not inferred topics; an ordinary sentence stays intact. */
export function queryParts(query:string):string[]{
  if(!/[、；;]|\n\s*\d+[.)、]/.test(query))return [query];
  const parts=query.split(/[、；;]|\n\s*\d+[.)、]/).flatMap(part=>part.split(/\s+and\s+|和|以及|及其/u))
    .map(part=>part.trim()).filter(part=>part.length>=2);
  return parts.length>=2&&parts.length<=6?[query,...parts]:[query];
}
function identity(provider:Provider|undefined):string{return provider?JSON.stringify([provider.url,provider.model]):'none';}
function cache<K,V>(map:Map<K,V>,key:K,value:V,limit:number){map.delete(key);map.set(key,value);if(map.size>limit)map.delete(map.keys().next().value!);}
/** A classified provider transport failure; the message stays the stage-level code callers already match. */
class ProviderRequestError extends Error {
  readonly failureClass:RetrievalFailure;
  readonly httpStatus:number|undefined;
  constructor(kind:'embedding'|'rerank',failure:RetrievalFailure,httpStatus?:number){
    super(`${kind}_request_failed`);this.failureClass=failure;this.httpStatus=httpStatus;
  }
}
const CONFIGURATION_FAILURES:ReadonlySet<RetrievalFailure>=new Set(['credentials_rejected','model_not_found','endpoint_redirected']);
function providerFailure(error:unknown):RetrievalDegradation|undefined{
  if(!(error instanceof Error))return undefined;
  if(error.message!=='embedding_request_failed'&&error.message!=='rerank_request_failed')return undefined;
  const failure=error instanceof ProviderRequestError?error.failureClass:'transport';
  const httpStatus=error instanceof ProviderRequestError?error.httpStatus:undefined;
  return {stage:error.message==='embedding_request_failed'?'embedding':'reranker',failure,
    attention:CONFIGURATION_FAILURES.has(failure)?'configuration':'transient',...(httpStatus!==undefined?{httpStatus}:{})};
}
function fallbackReasonOf(degraded:RetrievalDegradation):ProviderFallbackReason{
  const stage=degraded.stage==='embedding'?'embedding':'rerank';
  return degraded.attention==='configuration'?`${stage}_${degraded.failure as 'credentials_rejected'|'model_not_found'|'endpoint_redirected'}`:`${stage}_request_failed`;
}
function failureRank(degraded:RetrievalDegradation):number{
  return degraded.failure==='credentials_rejected'?0:degraded.attention==='configuration'?1:2;
}
/** HTTP status to failure class. The body is read only to recognize a model error and is never kept or logged. */
function httpFailure(status:number,body:string):RetrievalFailure{
  if(status===401||status===403)return 'credentials_rejected';
  if(status===404)return 'model_not_found';
  if(status===429)return 'rate_limited';
  if(status===408||status===504)return 'timeout';
  if((status===400||status===422)&&(/model[^.\n]{0,40}?(?:not[\s_-]*(?:found|exist)|does[\s_-]*not[\s_-]*exist|unknown|unsupported|invalid)/i.test(body)||
    /(?:unknown|invalid|unsupported|no[\s_-]+such)[\s_-]+model/i.test(body)||/模型.{0,12}(?:不存在|无效|不支持|未找到)/.test(body)))return 'model_not_found';
  return 'provider_error';
}
function redirectRefused(error:unknown):boolean{
  const cause=error instanceof Error?(error as Error&{cause?:unknown}).cause:undefined;
  return [error,cause].some(item=>item instanceof Error&&/redirect/i.test(item.message));
}

function configured(config: ModelConfig, stage: 'embedding' | 'reranker'):
  | { url: string; key: string; model: string }
  | undefined {
  const baseUrl = typeof config?.baseUrl === 'string' ? config.baseUrl.trim() : '';
  const key = typeof config?.key === 'string' ? config.key.trim() : '';
  const model = typeof config?.model === 'string' ? config.model.trim() : '';
  if (!baseUrl && !key && !model) return undefined;
  if (!baseUrl || !model || (key && !baseUrl)) throw new Error(`invalid_${stage}_config`);
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`invalid_${stage}_config`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`invalid_${stage}_config`);
  }
  return { url: endpoint(parsed, stage), key, model };
}

function endpoint(base: URL, stage: 'embedding' | 'reranker'): string {
  const expected = `/${stage === 'embedding' ? 'embeddings' : 'rerank'}`;
  const path = base.pathname.replace(/\/+$/, '');
  base.pathname = path.endsWith(expected) ? path : `${path}${expected}`;
  return base.toString();
}

async function embed(config: { url: string; key: string; model: string }, input: string[],deadline:number): Promise<number[][]> {
  const body = await request(config, { model: config.model, input, encoding_format: 'float' }, 'embedding',deadline);
  try {
    const data = record(body).data;
    if (!Array.isArray(data) || data.length !== input.length) throw new Error('invalid_embedding_response');
    const result: number[][] = new Array(input.length);
    for (const item of data) {
      const entry = record(item);
      const index = entry.index;
      const vector = entry.embedding;
      if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= input.length || result[index] || !Array.isArray(vector) || vector.length === 0 || vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
        throw new Error('invalid_embedding_response');
      }
      result[index] = vector as number[];
    }
    if (result.some(vector => !vector) || new Set(result.map(vector => vector.length)).size !== 1) throw new Error('invalid_embedding_response');
    return result;
  } catch {
    throw new Error('invalid_embedding_response');
  }
}

async function rerank(config: { url: string; key: string; model: string }, query: string, documents: string[],deadline:number): Promise<RerankResult[]> {
  const body = await request(config, {
    model: config.model,
    query,
    documents,
    top_n: documents.length,
    return_documents: false,
  }, 'rerank',deadline);
  try {
    const results = record(body).results;
    if (!Array.isArray(results) || results.length === 0 || results.length > documents.length) throw new Error('invalid_rerank_response');
    const seen = new Set<number>();
    return results.map(item => {
      const entry = record(item);
      const index = entry.index;
      const score = entry.relevance_score;
      if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= documents.length || seen.has(index) || typeof score !== 'number' || !Number.isFinite(score)) {
        throw new Error('invalid_rerank_response');
      }
      seen.add(index);
      return { index, score };
    }).sort((a, b) => b.score - a.score);
  } catch {
    throw new Error('invalid_rerank_response');
  }
}

async function request(config: { url: string; key: string; model: string }, payload: object, kind: 'embedding' | 'rerank',deadline:number): Promise<unknown> {
  return withModelAddress({stage:kind==='rerank'?'reranker':'embedding'},()=>traceModel({model:config.model,baseUrl:config.url},[],async()=>{
  const remaining=deadline-Date.now();
  if(remaining<=0)throw new ProviderRequestError(kind,'timeout');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(),remaining);
  try {
    recordModelDispatch();
    let response:Response;
    try {
      response = await fetch(config.url, {
        method: 'POST',
        headers: config.key ? { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (error) {
      throw new ProviderRequestError(kind,controller.signal.aborted?'timeout':redirectRefused(error)?'endpoint_redirected':'transport');
    }
    recordModelResponse();
    if (!response.ok) {
      // Only a 400/422 body can change the class; it is bounded and discarded after matching.
      const text=response.status===400||response.status===422?await response.text().then(value=>value.slice(0,4096),()=>''):'';
      if(controller.signal.aborted)throw new ProviderRequestError(kind,'timeout',response.status);
      throw new ProviderRequestError(kind,httpFailure(response.status,text),response.status);
    }
    try {
      const body=await response.json();
      recordModelUsage(body?.usage);
      return body;
    } catch {
      if(controller.signal.aborted)throw new ProviderRequestError(kind,'timeout');
      throw new Error(`invalid_${kind}_response`);
    }
  } catch (error) {
    if (error instanceof ProviderRequestError || (error instanceof Error && error.message === `invalid_${kind}_response`)) throw error;
    throw new ProviderRequestError(kind,controller.signal.aborted?'timeout':'transport');
  } finally {
    clearTimeout(timeout);
  }
  }));
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_provider_response');
  return value as Record<string, unknown>;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function projectionName(key:string):string {
  return `memory_${digest(key).slice(0,40)}`;
}
