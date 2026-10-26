# Dialogue, scene structure and manuscript backups

These tools work in the ordinary writing workspace. You don't need AI to label dialogue or split a scene.

The idea is that you can associate dialogue with particular characters, so that you can review all that character's dialog together to check you have given them a consistent voice.

## Label who's speaking

Select the spoken words, then choose **Scene tools → Label selected dialogue**, or **Label speaker** in the right-click menu. Choose a character's wiki page, another page, **Unknown**, or **Create character**. A new character gets an empty wiki page tagged `character`. The chooser starts with **Character pages only** on. Turn it off to see all wiki pages.

Open **Scene tools → Review scene dialogue** to change or remove a label. If it's detached from its passage, select the words you want first, then reopen the review to reattach it. A wiki page used by current or checkpointed dialogue can't be deleted while those links still need it.

## Read all of a character's dialogue together

Every wiki page for a character has a **Dialogue** action. It gathers that speaker's speech (that you have labelled), in manuscript order, with titles, descriptions, nearby text and links back to the exact words.

You can then read all of a character's lines together to check their voice is consistent. You can check the surrounding passage before deciding on a change, since people don't always speak the same way to a friend, an official and an enemy.

In a speaker's Dialogue view, **Evaluate this voice (AI)** asks your model to look at their linked current speech, surrounding text, descriptions and scene notes and advise if it detects any inconsistency. It considers accent, habits and consistency while allowing changes of audience, emotion, time and register. Follow the quotation links and use your own judgement. The feedback isn't saved with the project and of course it never rewrites your dialogue.

## Ask AI to suggest speakers

The AI can analyse the current scene, find dialogue, and attempt to match it to the name of the character who is speaking. Choose **Analysis → Dialogue speakers → Run**, the circular-arrow button labelled **Extract dialogue speakers from current scene**. It sends this scene, your scene notes, existing characters and confirmed labels to your chosen LLM.

The model may infer who's speaking or suggest a new name. Read the suggestions, correct the speakers, tick the ones you want, and choose **Accept selected assignments**.

**Cancel** stops the tab waiting, though a provider may finish work already sent.

## Marks, styles and tense

You can optionally highlight dialogue that has been labelled. In **Analysis**, show or hide dialogue marks and choose their colour and one of the four highlight/underline styles. This is just about whether the UI displays the highlight.

## Editing and structural changes

Dialogue labels stay linked to their scenes and wiki pages when titles or scene order change. Intact passages move automatically when you make ordinary edits. Deleting the speech can detach a label. You can always reattach a detached label yourself.

**Move a scene** You can move scenes up and down to restructure your story. You can also move the sticky notes in the storyboard view.

**Scene tools → Split at caret / selection start** keeps the text before the cursor in the original scene and puts the rest in a new scene immediately after it. You get to review the new title and description. Scene notes, Sticky notes colour and grid fields are copied as starting points.

Comments and dialogue wholly in the new scene move with their passages.

**Join with next scene** joins the next scene to the current scene, keeping the earlier scene's title, its scene notes and grid fields. Both scenes' descriptions are combined. Its comments and dialogue labels are copied into the joined scene.

Both split and join actions save your current scene and wiki edits, keep checkpoints and check that the project hasn't changed before they start. A failed save keeps your working text and the previous readable recovery file. On success, the resulting scene opens in the editor. You can't undo the whole split or join with the editor's Undo command.

You will of course have to check chronology, chapter/group fields, scene notes and citations after rearranging your story. The archive's readable `scene_changes.json` records the split/join, original titles, descriptions, cut position and separator.

## Plain-text backup

Choose **File → Manuscript backup → Download .txt**, or **Scene tools → Download manuscript (.txt)**. One UTF-8 file contains current scenes in reading order, each with a separator, numbered title, description and exact prose. It leaves out removed scenes and wiki pages.

Keep the `.txt` as a readable manuscript backup and the full `.verwrity.zip` to retain wiki notes, comments, dialogue, scene notes, structural history and checkpoints. Your zip file is also kept in the Verwrity user-data directory.
