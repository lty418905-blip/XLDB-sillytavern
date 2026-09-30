import type {ForgottenMarker,MemoryView} from './access.ts';
import {emotionalReactionLabels,type EmotionalReactionKey} from './retention.ts';
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

/** Interim line for a protected reaction (until MR6 restores the model's feeling). */
export function reactionLine(language:StoryLanguage,reactions:readonly EmotionalReactionKey[]):string {
  const labels=reactions.map(key=>emotionalReactionLabels[language][key]);
  return language==='zh'?`当时强烈的感受：${labels.join('、')}`:`Strong feelings at the time: ${labels.join(', ')}`;
}

export type RenderedMemory=Omit<MemoryView,'forgottenMarker'>&{forgotten?:string};

/**
 * A shallow copy for the context string only: the marker code becomes `forgotten` in the story language and a
 * protected reaction without a feeling gains the interim reaction line. The API views keep their codes.
 */
export function renderContextMemory(view:MemoryView,language:StoryLanguage):RenderedMemory {
  const {forgottenMarker,...rest}=view;
  const rendered:RenderedMemory={...rest};
  if(view.emotionalReaction&&rendered.feeling===undefined)rendered.feeling=reactionLine(language,view.emotionalReaction.reactions);
  if(forgottenMarker!==undefined)rendered.forgotten=forgottenMarker==='gist_faded'&&!rendered.feeling?
    gistFadedWithoutFeeling[language]:markerSentences[language][forgottenMarker];
  return rendered;
}
