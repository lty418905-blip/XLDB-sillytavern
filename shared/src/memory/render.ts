import type {ForgottenMarker,MemoryView} from './access.ts';
import type {EmotionalReactionKey} from './retention.ts';
import type {StoryLanguage} from './text-units.ts';

export {emotionalReactionLabels} from './retention.ts';

/** Appendix B with the fix-round-1 and round-2 wording reviews. Context text only; never stored, indexed or rewritten. */
export const markerSentences:{readonly [L in StoryLanguage]:Readonly<Record<ForgottenMarker,string>>}={
  zh:{
    details_faded:'细节已经记不清了。',
    gist_faded:'经过也记不清了，只剩下感觉。',
    scene_faded:'只记得有过这么一件事。',
    rest_inaccessible:'除此之外都想不起来了。',
  },
  en:{
    details_faded:'The details have faded.',
    gist_faded:'What happened has faded too; only the feeling is left.',
    scene_faded:"All that's left is that it happened.",
    rest_inaccessible:'Nothing else about it comes back.',
  },
};

/**
 * gist_faded claims a feeling is left. A row with nothing felt to show (a fact at feeling access, or a blocked
 * feeling without a remembered reaction) says only that the course of events has faded.
 */
export const gistFadedWithoutFeeling:Readonly<Record<StoryLanguage,string>>={zh:'经过也记不清了。',en:'What happened has faded.'};

/** gist_faded for a row that shows a feeling and remembered fragments (MR6 Appendix C). */
export const gistFadedWithFragments:Readonly<Record<StoryLanguage,string>>={
  zh:'经过也记不清了，只剩下感觉和几个零碎的印象。',
  en:'What happened has faded too; only the feeling and a few scraps are left.',
};

/**
 * One phrase per stored reaction key (MR6 Appendix A): zh without a subject, en in the first person. A fallback for
 * the context copy only, when the model's own feeling is empty or blocked. Never stored, indexed or rewritten.
 */
export const reactionPhrases:{readonly [L in StoryLanguage]:Readonly<Record<EmotionalReactionKey,string>>}={
  zh:{
    joy:'现在想起来还会忍不住笑',
    gratitude:'心里到现在还是暖的',
    affection:'想起来心里还是软的',
    relief:'还记得那口终于松下来的气',
    pride:'现在想起来还有点得意',
    sadness:'想起来心里还是沉甸甸的',
    grief:'想起来心口还是会疼',
    hurt:'想起来还是觉得委屈',
    anger:'一想起来就一肚子火',
    fear:'现在想起来还会心里一紧',
    worry:'想起来心还是悬着的',
    shame:'想起来脸上还是会发烫',
    guilt:'到现在心里还是过意不去',
    disappointment:'想起来心还是凉的',
    jealousy:'想起来心里还是酸溜溜的',
    longing:'到现在还是很想念',
    loneliness:'想起来还是觉得孤零零的',
    disgust:'一想起来就一阵反胃',
    awe:'那种说不出话的感觉还在',
  },
  en:{
    joy:'it still makes me smile',
    gratitude:'it still warms me',
    affection:'my heart still goes soft over it',
    relief:'I still remember the breath I let out',
    pride:"I'm still quietly proud of it",
    sadness:'it still weighs on me',
    grief:'it still aches, even now',
    hurt:'it still stings',
    anger:'it still makes my blood boil',
    fear:'it still tightens my chest',
    worry:'it still leaves me uneasy',
    shame:'I still wince thinking about it',
    guilt:'it still sits on my conscience',
    disappointment:'I still feel let down',
    jealousy:'I still wish it had been me',
    longing:'I still find myself missing it',
    loneliness:'it still makes me feel alone',
    disgust:'it still turns my stomach',
    awe:'it still leaves me a little speechless',
  },
};

/** The phrase of the first reaction only; none for an empty list or a key that is not an own entry of the table. */
export function reactionPhrase(language:StoryLanguage,reactions:readonly unknown[]):string|undefined {
  const key=Array.isArray(reactions)?reactions[0]:undefined;
  if(typeof key!=='string')return undefined;
  const table:Readonly<Record<string,string>>=reactionPhrases[language];
  if(!Object.hasOwn(table,key))return undefined;
  return table[key];
}

export type RenderedMemory=Omit<MemoryView,'forgottenMarker'|'emotionalReaction'>&{forgotten?:string};

const blank=(value:unknown):boolean=>typeof value!=='string'||!value.trim();

/**
 * A shallow copy for the context string only: the marker code becomes `forgotten` in the story language, the
 * structured reaction is left out, and a protected reaction without feeling text gains the phrase of its first
 * reaction. The API views keep their codes and their reaction.
 */
export function renderContextMemory(view:MemoryView,language:StoryLanguage):RenderedMemory {
  const {forgottenMarker,emotionalReaction,...rest}=view;
  const rendered:RenderedMemory={...rest};
  if(emotionalReaction&&blank(rendered.feeling)){
    const phrase=reactionPhrase(language,emotionalReaction.reactions);
    if(phrase!==undefined)rendered.feeling=phrase;
  }
  if(forgottenMarker!==undefined)rendered.forgotten=forgottenMarker!=='gist_faded'?markerSentences[language][forgottenMarker]:
    blank(rendered.feeling)?gistFadedWithoutFeeling[language]:
    Array.isArray(view.rememberedFragments)&&view.rememberedFragments.length>0?gistFadedWithFragments[language]:
    markerSentences[language].gist_faded;
  return rendered;
}
