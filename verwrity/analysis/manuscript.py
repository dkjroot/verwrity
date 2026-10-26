"""Explicit manuscript reviews using the project answer/evidence boundary."""

from dataclasses import dataclass

from verwrity.ai.interrogation import prepare_question
from verwrity.domain.story import StoryProject


@dataclass(frozen=True)
class ManuscriptTask:
    id: str
    name: str
    description: str
    prompt: str


MANUSCRIPT_TASKS: tuple[ManuscriptTask, ...] = (
    ManuscriptTask(
        id="narrative_voice",
        name="Narrative voice consistency",
        description="Review narrative voice across the whole manuscript, with passages to compare.",
        prompt=(
            "Review narrative voice consistency throughout all supplied manuscript scenes in narrative order. "
            "Focus on narration rather than dialogue: diction and register, sentence rhythm, narrative "
            "distance, tense and person, imagery, and the narrator's attitude. Establish the prevailing "
            "voice or distinct voices before identifying possible unintended shifts across scenes. "
            "Respect deliberate changes of narrator, viewpoint, time, mood, genre, free indirect speech, "
            "and character-specific voices; consistency does not mean uniformity. Do not flag "
            "declared viewpoint characters or narrators merely for having distinct voices. Use the "
            "author-provided scene metadata to compare like viewpoints where possible, and assess "
            "each passage against its declared voice notes. A conflict between stated intent and "
            "the prose may warrant review, but a declared deliberate change is not itself a fault. "
            "Do not flag different characters' dialogue as inconsistent narration. Distinguish supported observations from "
            "uncertain editorial judgement and explain plausible intentional reasons for a shift. "
            "Write a concise report with a voice overview, up to four possible concerns, and limitations. "
            "For each concern name the scenes, quote the exact passage where the possible shift occurs "
            "in the report itself, and explain which words or sentence features demonstrate the shift. "
            "Put that same excerpt in the evidence array with its correct scene ID. You may also quote "
            "one baseline passage for that concern, but only if you explicitly compare its voice with "
            "the flagged passage; include both excerpts in the evidence array. Never return only "
            "baseline passages while omitting the passage you flag. Every evidence item must be an "
            "exact excerpt discussed in a specific concern, directly supporting that concern. Do not "
            "add general examples for the voice overview, nearby text, or passages merely mentioning "
            "the same character or setting. Before responding, check that every concern has its "
            "flagged excerpt in the evidence array and remove unrelated evidence. If no concerns are "
            "supported, return an empty evidence array. Use up to eight citations total. "
            "Do not invent excerpts or claim exhaustive certainty. "
            "If there is only one non-empty scene, explicitly say that cross-scene consistency cannot "
            "be assessed. If no supported concerns are found, say so instead of manufacturing findings. "
            "Do not rewrite passages or decide the author's intended voice."
        ),
    ),
)


def manuscript_task(task_id: str) -> ManuscriptTask:
    for task in MANUSCRIPT_TASKS:
        if task.id == task_id:
            return task
    raise ValueError("Choose a valid manuscript task.")


def prepare_manuscript_task(project: StoryProject, task: ManuscriptTask) -> tuple[dict[str, object], str]:
    # Reviews always cover current scene heads, regardless of Q&A sliders/history.
    # Wiki facts and historical prose cannot establish the current narrative voice.
    return prepare_question(project, None, task.prompt, 100, 100, False, [])
