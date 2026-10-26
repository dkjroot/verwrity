# Verwrity feature reference

This guide explains the tools you can use in Verwrity, how to set up the optional features, and what to try if something goes wrong. I don't expect anyone to read it all. If you're stuck on something, search for it in here and you might find useful information.  For installation, see [the README](../README.md); for a tour of the workspace, start with [Your first days with Verwrity](START-HERE.md).

- [Writing workspace](#writing-workspace): editing, layout, scene notes, spelling and the wiki.
- [AI and speech capabilities](#ai-and-speech-capabilities): read-aloud, questions, dictation, Project words and OCR.
- [Project files and recovery](#project-files-and-recovery): saves, backups, history and recovering your work.
- [Dialogue and scene operations](#dialogue-scene-structure-and-plain-text-backups): speaker labels, splitting and joining scenes, and text exports.

The shorter [dictation, OCR and speed reading guide](IMPORT-AND-READING.md) walks through those tools as practical tasks. This reference has the extra settings and troubleshooting details when you need them.

## Writing workspace

The workspace has three main panels. The **storyboard** on the left helps you organise scenes, the **manuscript** in the centre is where you write the selected scene, and the **wiki** on the right holds your notes about people, places and anything else you need to remember.

A new project asks for a name, creates Scene 1 and saves a named copy in your library. You can add scenes as you go, arrange them with Sticky notes or use the storyboard grid to track your own planning fields. Removing a scene puts it in History, where you can bring it back unless you've chosen to delete it permanently.

Your manuscript is saved as plain text, including paragraph breaks and blank lines. The fonts, colours, page sizes and highlights are there to make writing and reviewing comfortable; they don't add formatting codes to your prose.

Use **Save project**, or **Ctrl+S / Cmd+S**, to save the project, including the active scene and pending wiki edits. The Save button is orange when the named copy needs updating and green when it's current. Verwrity also keeps recovery drafts, but those serve a different purpose from a deliberate save or backup. See [saving and recovery](#working-heads-named-saves-and-recovery) for the difference.

### Page views and editing

You can write in a continuous view, on single pages or in two-page spreads. Choose A4, US Letter, 6 × 9 inch or 5.5 × 8.5 inch pages, then use **Fit width** or **Fit height** to suit your screen. Font, size and colour controls let you choose how the manuscript looks while you work. The text map gives you a quick way to move around a long scene.

**Find and replace** looks for the exact text you enter, either in the current scene or across the current manuscript. It doesn't search wiki notes, removed scenes or recorded revisions. Use the case option when capital letters matter. **Replace** changes the first matching occurrence in the chosen scope, in reading order; it doesn't necessarily mean the match you've clicked. **Replace all** changes every match in that scope, so it's worth making a backup before a broad replacement.

The sentence-spacing controls in **Edit** let you keep spacing **As typed**, or use one or two spaces between sentences. Converting an existing scene is a separate action, and you can undo it if the result isn't what you wanted.

Leading spaces and tabs tell Verwrity whether a paragraph continues a section or starts a new one. **Show indentation** makes those spaces easier to see without changing them. The paragraph-marking controls make an actual, undoable change to the paragraph you're in. You can also show a small, dim asterisk at section starts; those markers are only a reading aid and aren't inserted into your manuscript.

Pasting text converts unusual horizontal spaces, such as non-breaking spaces, to ordinary spaces while keeping their number. Tabs and paragraph breaks are preserved. For text already in a scene, **Edit → Normalize spaces** makes that conversion when you ask and can be undone. It doesn't run just because you open a scene.

### Comments and scene versions

Select a passage and add a comment when you want to leave yourself a note. You can choose its colour and one of four marking styles without changing the note itself. Resolving a comment keeps it for reference; deleting it removes the note. If you also copy a note to the TODO wiki page, that copy is a separate note, so editing one doesn't edit the other.

If you delete or substantially change the passage a comment referred to, the comment remains available in **Analysis → Comments ⋯ → Review comments**. You can select a new passage and attach it there. Verwrity won't guess which repeated phrase you meant.

Before a substantial revision, use **Versions → Record revision** to keep a checkpoint. You can read an older version, compare it with your current scene, or copy it back to become the editable version. Older versions are read-only until you do that. Restoring also keeps the version you're replacing, so you can return to it later.

A scene checkpoint covers its prose, comments and dialogue labels. It doesn't roll back your wiki, scene order or current scene notes. For project-wide backups, export the project archive as well.

### Project features and Fingal mode

Open **Settings → Prototype features** to choose optional tools for this project. New projects start with these tools turned off, and your choices travel with the project. **Save features** updates the recovery draft; use **Save project** as well to update the named library copy.

You can enable the map editor or game character sheets individually. They can be useful for a novel or an RPG setting even if you aren't making a game. **Fingal mode** includes those tools, item records and Fingal story import/export. Turning Fingal mode off restores your individual tool choices. Turning a tool off hides its controls and keeps its saved information, so you can return to it later.

**Map** replaces the centre manuscript view with the map and changes the left panel to location navigation. The wiki stays on the right. Choose **Back to manuscript** to return to your writing, including unsaved text and undo history. Click an empty cell to create a location, or click a location or starting character to open its wiki page. **Edit map location** lets you describe the place and set its connections, travel times, interiors and items.

Character and location forms sit alongside your wiki notes. Use **New character**, **Add character sheet** or **Add map location** as appropriate. If a name matches a page you already have, **Use existing page** lets you keep its notes and history rather than create a duplicate. You can write the background in your own words and fill in the structured fields you need; you don't have to edit JSON.

For Fingal, keep the Verwrity archive as your master project. **File operations → Review import** previews a Fingal story file and, after confirmation, creates a separate project. It doesn't invent manuscript scenes to go with an imported world. Save that project under a name if you want it in your library.

**Review export** checks your world before downloading a `.fingal.json` file. Each map needs an initial location, at least one character must be a **Player template**, and referenced items need definitions. The review explains anything missing so you can fix it. Exported worlds describe the starting world, not a player's saved playthrough, and they don't include your manuscript prose. Import and export run locally and don't change Fingal's live files. See [Fingal world authoring](STORY_AUTHORING.md) for the full workflow and current limits.

### Focus and workspace layout

Drag the separators to resize the side panels, or focus a separator and use the arrow keys. The panels scroll independently, which helps on a small screen. Narrow screens use a stacked layout.

**Focus Mode** gives you a larger writing area while keeping ordinary cursor movement and editing. **Typewriter Mode** can lock the caret so you keep moving forwards instead of revising the sentence you've just written. With the caret locked, you can type, press Return and use Backspace, but selection, navigation, Delete and undo/redo are unavailable. Use **Unlock caret** when you want to revise or move elsewhere.

The **Layout** menu lets you hide bars and panels or maximise the editor. A floating **Workspace** button remains available when the main controls are hidden, so you can bring them back.

Verwrity remembers a separate layout for ordinary writing, Focus Mode and Typewriter Mode in this browser. Leaving a focus mode returns you to your normal workspace. If you've lost track of your layout, **Restore default layout** brings the normal controls and panels back. It doesn't change your manuscript, text styling or page-view preferences.

### Speed reader

Open **Speed reader** from the writing toolbar or the floating Workspace controls. It shows your manuscript a few words at a time against a black background. You can start at the caret, the beginning of the scene or the beginning of the manuscript, and stop at the scene or manuscript end. It includes unsaved writing in the active scene. Return to the current editable scene first if you're viewing an older version.

The reader opens paused. Choose **Play**, use **Space** to pause or resume, and **Escape** to return to your writing. Switching away from the tab or window pauses it too. **Restart** takes you back to your chosen starting point. Your manuscript and editing position are kept while you're reading.

Choose the number of words in each group and a speed between 30 and 2,000 words per minute. Font and size are separate from your manuscript settings. You can also change how long a group is visible and how many times it flashes before moving on. Repeating a flash gives you another look at the same words within the allotted time; it doesn't increase the reading speed. Groups stop at paragraph and scene boundaries, so the average speed may be a little lower than the setting.

Changing the reading range or group size restarts that range, and timing changes pause playback so you can check the new settings. Very short flashes depend on what your screen and browser can display. The reader accepts up to five million characters, and its preferences stay in this browser rather than in the project archive.

### Local Help and workspace tips

**Help** has a topic menu for finding instructions while you work. Its top bar stays on screen as you scroll, so **Back to your story** is always within reach. Following a Help link saves current edits first.

When there's spare room below the wiki, a **Did you know?** card offers tips and links to the relevant Help topics. Use **Next tip** to browse, or dismiss it if you'd rather have it out of the way. Dismissal lasts through navigation in that tab; a reload, a new tab or a new day can bring the cards back. They hide when the wiki needs the space or you're editing it.

Occasional support cards link to [Buy Me a Coffee](https://buymeacoffee.com/dkjroot). They don't contact an outside service unless you follow the link, and you don't need to contribute to use Verwrity.

### Scene metadata and author intent

**Scene metadata** in the manuscript toolbar, or **Metadata** on the storyboard, opens a card for the scene name, description and optional notes about your intentions. You can record viewpoint character, narrator, perspective, tense, place, time, voice and purpose. Leave anything blank if it doesn't help you.

Viewpoint and narrator are separate because they aren't always the same person. For example, an adult narrator might be describing what they understood as a child. These notes give you somewhere to state that intention without putting an explanation into the prose.

AI scene reviews and project questions receive the relevant scene notes along with the writing. They should use the notes to understand what you're trying to do, while drawing quotations from the actual manuscript. Changing the notes clears old scene-review findings without starting another model call. Read-aloud speaks only the requested prose or answer, and speech recognition doesn't receive these notes.

### Offline thesaurus

Right-click a word in the manuscript to look it up in the local English thesaurus. You can also select words or a short phrase. Expand a sense to see its alternatives; synonyms, antonyms and related or broader terms are labelled separately, because they aren't all interchangeable. The **Word or phrase → Look up** field lets you try another spelling or the base form of a word.

Nothing changes until you click an alternative. That replaces the targeted text and can be undone. Check the result in its sentence: the dictionary doesn't choose the right sense for you or automatically turn an alternative into the right grammatical form. You can look up words in an older revision or locked Typewriter view, but replacement is unavailable there.

Press **Escape** or click outside to close the menu. **Shift+right-click** opens the browser's usual menu. The thesaurus is bundled with Verwrity and works offline without an AI model or key. It uses WordNet-derived MyThes data; see the [third-party credits](../THIRD_PARTY_NOTICES.txt). It is separate from the optional AI **Super Thesaurus** review below.

### Spelling and LLM scene reviews

#### Spelling

Verwrity has its own offline spelling checker. Turn it on in **Analysis** to check a scene. It accepts American, British, Canadian and Australian spellings together, so it won't enforce a single house style. It also recognises your saved dictionary words and accepted Project words, including wiki names and aliases.

Clicking a marked word leaves the caret in your writing. To accept a spelling, right-click and choose **Word lists…**, or open **Settings → Word lists**. Add it to User words if you want it accepted across projects, or to Project Words if it belongs only to this story. [Project words](#project-words) also lets you share names and specialist terms with dictation and OCR.

Editing text or changing dictionaries makes the previous spelling check out of date. Use the rerun control when you're ready; Verwrity doesn't continuously check as you type. It remembers whether spelling is enabled when you change scenes or reload, but restoring that preference doesn't start a check. Colours and marking styles are personal settings rather than part of the portable story.

#### AI scene reviews

These reviews use the text model you've selected in **Settings → AI Models**. Each looks at the current scene and highlights passages with an explanation. They don't change your words. A quotation can be checked against the manuscript, but that doesn't make the model's interpretation right; you still decide whether a finding is useful.

| Review | What it can help you look for |
|---|---|
| **Cliché Detector** | Familiar expressions, worn metaphors, stock gestures and predictable descriptions. Deliberate motifs, irony and character voice still matter. |
| **Usage Detector** | Words or idioms that appear to mean something different from what the sentence needs. Its approach is inspired by Fowler's *Modern English Usage*, but it uses the model's language knowledge rather than looking entries up in Fowler or a dictionary. |
| **Grammar Checker** | Agreement, verb forms, pronouns, sentence structure and punctuation. Deliberate fragments, dialect and character speech shouldn't be treated as mistakes just because they aren't formal prose. |
| **Super Thesaurus** | Weak, vague or predictable word choices, with suggested words or short phrases and an explanation of how their meanings differ. These remain suggestions for you to consider. |
| **Tense Checker** | Apparently unintended changes of tense, while allowing speech, flashbacks, present truths and deliberate shifts in time. |

Each review has **Run**, **Cancel**, **Clear**, colour and marking-style controls. You can edit its prompt to ask for something more suited to your writing. **Restore default** removes your custom prompt and returns to the version supplied with Verwrity.

You can also create up to 20 custom reviews, with names up to 80 characters and prompts up to 8,000 characters. These belong to your local user settings, so you can use them across projects without putting them in story archives.

Use a review's Run control to request that review, or **Rerun analysis** to run spelling and the enabled reviews again. Several enabled reviews mean several model requests, which matters if you're paying for an API. Opening a scene, restoring a preference or typing doesn't start paid reviews automatically.

If you edit after a review, findings on unchanged passages can remain to help you work through them, while findings on changed passages disappear. The remaining findings are still from the earlier review. Switching prose versions or changing scene notes clears them, and a result that arrives after you've changed its source is discarded. Run another review when you want an assessment of the new draft.

Overlapping highlights keep the explanations from each enabled review. The findings list can take you to the passage, and the colour or style controls help you distinguish tools. Results are temporary and aren't stored in the project archive. A scene review accepts up to 200,000 characters and returns at most 100 findings; your chosen model may have a smaller limit.

### Wiki editing and navigation

The wiki is for your story knowledge, research and plans. You can write things the reader hasn't learned yet, things a character doesn't know, or facts that never need to appear in the manuscript. Your notes don't become wrong just because the prose hasn't stated them.

Create pages with titles, comma-separated tags and alternative names or aliases. Use `[[Page title]]` to link a page, or `[[Page title|words to display]]` when you want different link text. A link to a missing page offers to create it. Backlinks show which other wiki pages refer to the page you're reading.

The formatting preview supports headings, lists, quotations, bold, emphasis, inline code and web links. **Insert form → Character profile** appends an outline to the page you're editing, leaving your existing notes in place. Wiki edits need to be saved; saving a changed page keeps the previous version in its history, up to the latest 100 versions. Restoring an older page also keeps the version being replaced.

Renaming a page updates explicit links in current wiki pages, but doesn't rewrite the manuscript. Titles and aliases can also act as links from your prose, even when wiki highlighting is turned off. Following one reveals the wiki if you've hidden it. You can select manuscript text and create a blank wiki page from the context menu; that doesn't copy the passage into your notes.

Wiki search covers titles, aliases, tags and page text, with matching passages highlighted. It doesn't search your manuscript or old page versions.

#### Asking AI to help with a wiki page

Give a page a purpose if you want the model to know what belongs there. You can write this yourself or ask **Suggest purpose** for a starting point and edit it. Population and refresh use the current manuscript to find material for the page. They don't run when you simply open or edit it.

Text you've written stays protected. AI-maintained sections can be updated when you ask for a refresh, while proposed changes to your own notes appear as suggestions for you to accept or dismiss. That means an explicit refresh can update AI-maintained text directly; it doesn't require a separate acceptance click for every such paragraph. Page history lets you recover an earlier version.

The wiki marks AI-generated text and provides its source details. Editing an AI paragraph makes that paragraph yours, protecting it from later automatic replacement. Other AI paragraphs can remain available for refresh. At the end of an AI block, **Enter** starts a new human paragraph; **Shift+Enter** adds a line break within the block. **Add human paragraph** is available at the end of the page too.

If you want the model to maintain part of your own notes, select that part and use **Mark as AI maintained**. Use **Mark as human owned / protected** to take control back. Save the page after changing those permissions. Giving permission doesn't itself call a model, and a section you handed over can still be identified as originally written by you.

The instruction box lets you ask for a particular job, choosing page-only, current-scene, scene-range or whole-manuscript context. For example, you might ask it to organise existing notes or prepare provisional ideas. Current scene and page edits are saved before that request. AI work without verified manuscript evidence carries **Warning: no citation**, including creative suggestions you accepted. That warning is shown beside the content rather than inserted into your prose.

Read a proposed replacement carefully before choosing **Accept suggestion**. Acceptance replaces that part of the page, records it as AI-generated and keeps the previous version in history. **Dismiss** leaves your text in place. Source links help you check what the model relied on, but they don't prove its reasoning.

Cancel a pending request or move away from the page to discard a result that hasn't been applied. The provider may still finish its work. Changes you've already saved can be recovered through wiki History. If a save fails, keep the editor open and copy your unsaved text before reloading or trying a different version.

Wiki requests accept up to one million manuscript characters, including scene notes, a 100,000-character wiki page and 100 proposed changes. Your model also needs enough capacity for the request. An oversized manuscript isn't reduced to a sample and presented as a complete review.

### Useful shortcuts

| Action | Shortcut |
|---|---|
| Save the project, active scene and pending wiki edits | **Ctrl+S / Cmd+S** |
| Open manuscript find and replace | **Ctrl+F / Cmd+F**; **Escape** closes it |
| Send a project question | **Enter**; **Shift+Enter** adds a new line |
| Dictate into the focused writing field | Hold and release **Right Ctrl**, or double-press it to keep recording |
| Cancel quick dictation | **Escape** |
| Pause or resume the speed reader | **Space**; **Escape** returns to writing |

Typewriter's caret lock intentionally disables navigation and undo shortcuts until you choose **Unlock caret**.

## AI and speech capabilities

Text models, read-aloud, speech recognition and OCR have separate settings in **Settings → AI Models**. You can use any combination, or none. A local model runs on your computer after you've downloaded its files; an online service receives the text, audio or images needed for the job you request.

Verwrity asks you to acknowledge the exact remote service address before using it. Changing that address clears the saved key and permission, so check both when you switch services. A subscription to a provider's chat website doesn't necessarily include API access. You may need an API account, a key and paid usage separately.

Install optional packages into the same Python environment you use to start Verwrity. The [README installation tables](../README.md#run-locally) give Windows and Linux commands for each feature. Stop the server before installing packages, then start it again afterwards. Installing a package or selecting a provider doesn't run a review.

Provider settings and API keys stay on this computer, outside project archives. Keys are stored in local JSON rather than an encrypted password vault, so keep your `user_files/` directory private.

AI Models also offers tests for saved settings. These use sample text or an image, or an audio file you choose, rather than your story. Tests and model downloads only start when you request them, and online tests may incur provider charges.

### Read-aloud and TTS providers

Choose a text-to-speech provider, voice and speed in **AI Models**. **Read scene** above the manuscript saves and reads the active scene. It doesn't read the whole manuscript, wiki notes or scene metadata. You can pause, seek through the recording or clear it. Generated audio isn't part of your project archive.

For local speech, **Kokoro** uses your CPU or a supported NVIDIA CUDA setup. Install `local-tts` for CPU or `local-tts-cuda` for CUDA, choosing one of the two. **Download Kokoro files** offers the roughly 338 MiB model and voice download; you can instead point Verwrity at files you already have. Once those files are available, speech is generated locally without sending your text online. CUDA also needs compatible drivers and libraries.

For **Microsoft Edge TTS**, install `remote-tts`. It needs no API key, but it is an online Microsoft service and receives the text you ask it to read. Availability depends on that service. **Google Cloud TTS** is another online option and needs a Google Cloud API key and the appropriate account setup.

Each remote voice has its own disclosure in AI Models. Saving your acknowledgement authorises later reads with that configuration, without another confirmation for every scene. If you enable reading completed AI answers, that answer goes to the voice provider you've selected too, even when the text model itself runs locally.

### LLM configuration and project questions

Choose the API format your text-model server supports: OpenAI-compatible, Anthropic Messages or Gemini. Enter its address, model name and any required key. The format needs to match the server; choosing OpenAI-compatible doesn't mean the server must belong to OpenAI.

For example, a local llama.cpp server may listen at `http://localhost:8081`; Verwrity handles the usual API path for that configuration. You still need to start the model server separately. Verwrity connects to it rather than loading a GGUF model itself.

#### Asking about your story

Use the Q&A dock to ask questions about the selected story context. **Enter** sends the question and **Shift+Enter** adds a line. Verwrity saves the active scene draft first so the question can include your latest writing.

The earlier/later-scene controls decide how much manuscript context to include, with both initially set to 100%. You can also include wiki context. This is a direct selection of material for the question, so a large selection needs a model that can handle it. It isn't a search system that secretly picks a few passages and treats those as the whole story.

Click a citation to inspect the quoted passage. Verwrity checks those quotations against the selected writing, but a model can still draw a poor conclusion from a real quotation. Treat an answer as something to consider, especially when it makes a claim about your intentions.

The current tab keeps up to eight turns of conversation for the project. **Clear** removes that conversation; clearing manuscript AI highlights is a separate action. Answers aren't saved into your manuscript or wiki. **Read completed answers** is optional and uses the configured voice provider. Typewriter Mode hides the Q&A dock to keep the writing area clear.

#### Asking about a selected passage

Select manuscript text and use the question action in its context menu when you want the answer to focus just on those words. Capturing the selection doesn't call a model; you still send the question yourself. This scope excludes other scenes, wiki notes, metadata and previous conversation. If you edit the captured text, select it again rather than rely on the old capture. Whole-manuscript Tasks keep their own scope.

**Suggest alternatives** is a separate shortcut that does call the text model immediately. It asks for a few possible alternatives to the selected wording, using the containing sentence and nearby sentences to understand the context. It doesn't include other scenes or wiki notes, and it doesn't insert the suggestions. The selection can be up to 4,000 characters, with bounded context on either side. Read the choices in your sentence and make any change yourself.

### Whole-manuscript tasks

The **Manuscript tools** menu beside Scene tools offers dedicated reviews, starting with narrative voice consistency. These look at every current scene and its author notes, regardless of the ordinary Q&A sliders. They don't include removed scenes, older revisions, wiki pages or earlier conversation.

A whole-manuscript review needs a model that can accept the complete input. If it won't fit, Verwrity reports that rather than silently reviewing a sample. The report can link you to quoted passages, but remains a temporary answer in the tab. It doesn't change your manuscript or create permanent story facts.

### Speech-to-text and dictation

There are two ways to dictate: quick dictation into the field you're using, and **Dictate draft** for a longer session that you want to review in sections.

#### Setting up speech recognition

For offline recognition, install `local-stt` and choose **Faster Whisper** in AI Models. Download a complete model through the explicit download controls, or select files you already have. Recognition doesn't download missing files while processing a recording and doesn't send the audio online. CPU recognition is available; CUDA needs a working NVIDIA setup and the required runtime libraries.

Hosted options include OpenAI and Groq Whisper, both of which need the provider's API key, even where a free allowance is available. A custom compatible server may have different authentication requirements. Online recognition sends audio to the configured endpoint after you grant permission. It doesn't receive your manuscript or scene notes as transcription context.

Your browser also needs microphone permission. Localhost works for local use; a remotely opened browser page generally needs HTTPS for microphone access.

#### Quick dictation

Put the caret where you want the words, then use the microphone control or hold **Right Ctrl** while speaking and release it to transcribe. Double-press Right Ctrl to keep recording without holding the key. Press **Escape** to cancel. Quick recordings have a five-minute limit; use Dictate draft for longer work.

Quick dictation works in the manuscript, wiki editor, question box and wiki instruction box. You can choose a different shortcut, such as Right Alt, Right Shift or F8–F10, if Right Ctrl clashes with something you use.

Recognised text is inserted at the captured caret position and can be undone. It doesn't replace a selection. If you've changed the destination while recognition was running, Verwrity keeps the transcript available so you can copy it or explicitly insert it where you now want it. Dictating into the wiki still leaves a page to save; dictating a question doesn't send it automatically.

#### Recording a longer draft

Open **Dictate draft** from **Scene tools**. Choose the manuscript position where you eventually want the draft, then start recording. **Pause** lets you take a break, **Resume** continues, and **Finish recording** ends recording while allowing queued sections to finish transcription. **Cancel queued work** stops pending processing and keeps completed text and pending audio for an explicit retry. There isn't the quick recorder's five-minute limit.

The recorder divides the session into sections around pauses in your speech, with a time limit on each section so a long stretch can be processed. Use **Page turn / chunk boundary** when you want to end a section yourself. If recognition falls behind, the browser loses access to the device or the page is suspended, recording may pause; check the status and resume when you're ready. The microphone won't resume automatically. A draft holds up to 500 sections, and dictation buffers share a 128 MiB storage limit in this browser, so finish and save your work periodically during long sessions.

#### Importing an audio file

You can also import an existing voice note or recording, up to 24 MiB per file. Supported formats include WAV, MP3, M4A/MP4, AAC, FLAC, OGG, Opus, WebM, AIFF, WMA, AMR and 3GP, subject to the decoder supporting the file's codec. Decoding and splitting happen locally, and the original file isn't changed.

If audio import isn't installed, add it from the project folder:

**Windows PowerShell**

```powershell
venv\Scripts\python.exe -m pip install -e ".[audio-import]"
```

**Linux, macOS or WSL**

```sh
venv/bin/python -m pip install -e '.[audio-import]'
```

Local Faster Whisper already includes this decoder. The separate package is useful when you use hosted recognition but still want to import files. Imported sections are added to the current draft. If an import fails partway through, completed sections remain; check them before importing the same file again, or you may repeat the beginning.

#### Reviewing the transcript

Each section keeps the raw transcript. You can use that directly or ask the text model for cleanup, then compare the result. Cleanup tries to recover plausible words from imperfect speech recognition and improve punctuation, capitals and paragraphing. It can still misunderstand you, particularly with names, so read changed wording rather than assume it heard correctly.

Cleanup receives the current section and your saved [Project words](#project-words), not the rest of your manuscript or every earlier recording. If recognition and cleanup use different remote services, audio and text permissions are separate.

Automatic cleanup starts enabled when a text model is configured and applies to new sections. You can turn it off, review a section individually or use **Run cleanup for all sections** for available, unapproved sections. Existing approved or inserted choices are protected. Changing Project words lets you explicitly rerun an unapproved section; it doesn't start another paid request by itself. If the model has no useful changes, the raw transcript is still available.

Choose **Keep raw** or **Use reviewed cleanup** for each section, and edit that choice if needed. Once recording, import and processing have finished, **Auto-approve all** becomes available. It uses completed cleanup where available and raw text otherwise for sections you haven't chosen yourself. It doesn't make another model call or insert anything into the manuscript.

#### Inserting and keeping your work

**Insert approved sections at caret** inserts the approved, not-yet-inserted sections in recording order, as one undoable change. If you want a different destination, hide the dialog, place the caret and reopen it before inserting.

Check **Clear recordings** before inserting: it starts enabled, and after a successful insertion it removes the whole current dictation buffer, including unapproved sections. Turn it off if you still need any of them. A failed insertion doesn't clear the buffer. Later cleanup doesn't change words you've already inserted into the manuscript.

The draft buffer is stored in this browser and can survive closing and reopening the dialog or tab. Completed transcripts are kept before their audio is removed; pending or failed recordings can retain audio for another attempt. Reopening doesn't automatically send those recordings to a provider. Clearing browser data can remove the buffer, and a crash may lose the current recording or unsaved edits, so insert reviewed text into your manuscript and save the project when you want to keep it. The buffer isn't part of a project export.

If an insertion is interrupted, inspect the manuscript before trying again to avoid adding the same text twice. **Clear / start fresh** removes the current dictation buffer after confirmation; it doesn't remove manuscript text or your saved Project words.

### Project words

Open **Settings → Word lists** to keep names and specialist spellings consistent across this story's spelling checker, dictation cleanup and OCR correction. The list is part of the project, so it travels with exports and backups. Words from your project dictionary and wiki titles or aliases are also recognised.

You can type terms yourself or scan the saved current manuscript for possible words. A scan groups candidates for you to review; it doesn't accept them automatically or search old scene versions. Save the writing first if you want the scan to include your latest edits. Choose which spellings belong in Project Words; user words are accepted by spelling across all your projects.

You can also explicitly create a blank wiki page for a selected term. Existing titles and aliases prevent duplicate pages; the scan doesn't invent facts or fill the new page with generated prose. The scan runs locally without a model.

The shared list accepts up to 1,500 terms, each up to 100 characters. Local scanning accepts up to two million manuscript characters; scanning stays on this computer and does not call an LLM. Saving words can make existing spelling findings out of date, but doesn't rerun spelling or paid cleanup. Use **Save project** to include the latest list in your named library copy.

For OCR, you can collect likely words from raw results, including unchecked pages, before running correction. Both OCR correction and dictation cleanup receive the saved list with the particular page or section being reviewed. If you change it, rerun the unapproved results you want checked again. Approved and inserted choices aren't rewritten.

### Import manuscript pages with OCR

Open **Import manuscript pages** from the scene tools to turn photographed or filmed pages into text. You choose which captures to recognise, review the results and decide what to insert. It can be useful for typewritten pages and printed drafts; handwriting recognition is more experimental and needs careful checking.

#### Importing photos and video

Photos can be JPEG, PNG or WebP, up to 24 MiB and 48 megapixels per image. Convert HEIC photos first. Video import accepts files up to 1 GiB, including MP4 and MOV where their codecs are supported. A buffer can hold up to 500 captures, and OCR buffers share a 256 MiB storage limit in this browser.

Importing a video picks still images for you to inspect before running OCR. Check that every page is represented and that a hand, page turn or blurred frame hasn't hidden the words. Duplicate detection helps reduce repeated captures, but it isn't a guarantee of completeness. The thumbnail numbers remain useful for spotting gaps even when some captures are unchecked.

You can choose one of four orientations before importing or rotate existing uninserted pages. Crop and fine rotation let you straighten a page and remove its surroundings. Use earlier or later video frames when a selected still isn't clear enough. **Keep this video frame** retains the new capture and leaves the old one unchecked; **Keep this capture instead** changes which nearby capture is selected while keeping both available. You can reorder pages or add a photo after the selected page if something is missing.

The video timeline is available while that video is open in the tab. After reloading, reselect the original video if you want to find another frame. The original video isn't stored in the recovery buffer. An interrupted import can leave useful captures already loaded, so inspect those before reimporting the whole video.

**Show unchecked thumbnails** reveals captures excluded from processing. The duplicate threshold starts at 75%, with lower settings excluding more similar captures and higher settings retaining more. Rechecking duplicates respects captures you've chosen manually or already processed. Checking a page decides whether it participates; it doesn't immediately run OCR.

#### Making the image easier to read

The image profile offers brightness, contrast, sharpness, image size, greyscale and black-and-white threshold controls. Adjust these while looking at the preview. A setting that makes faint letters clearer can help recognition; pushing contrast or shrinking the image too far can lose punctuation and fine strokes.

Every preview is made from the saved original image. For example, increasing brightness twice doesn't brighten an already brightened copy each time. **Apply to this page** makes those settings the image that OCR will receive. Applying a profile to all uninserted pages also lets you use it for future captures, while keeping each page's own crop and rotation.

If a page has already been recognised, changing its image asks you to discard that page's OCR result and review first. Confirming removes its raw recognised text, correction, review edits and approval, so you'll need to recognise and check it again. The original photo remains available, and text you've already inserted into the manuscript isn't changed.

Removing a profile removes its image adjustments while keeping crop and rotation. Stopping its use for future captures doesn't undo profiles already applied to existing pages. The default longest-edge size is 1,288 pixels; increase it if letters are too small, while allowing for more processing time and memory. Greyscale alone doesn't necessarily reduce an online model's image charge.

#### Choosing local or online recognition

Local OCR keeps page images on your computer. **olmOCR 2** is the main local option; **PaddleOCR-VL 1.6** is experimental. A capable NVIDIA GPU helps substantially. CPU recognition is possible but can be very slow, and larger images require more memory. There's no automatic fallback to an online service if local recognition fails.

Online choices include Mistral OCR, Azure Read and Google Cloud Vision. They require the appropriate provider account and key, and may charge for use. Configure the service and acknowledge its address in **AI Models**, then enable online image processing in the import tool. Only selected page images are uploaded, not the whole video, wiki or other scenes.

Cancelling stops waiting and prevents further queued pages from being sent. A request already sent to an online provider may still finish and be charged for. Failed requests aren't automatically resubmitted.

| Provider | Address and setup |
|---|---|
| Mistral OCR | Use `https://api.mistral.ai/v1/ocr` and the configured OCR model, currently `mistral-ocr-4-1`. |
| Azure Read | Use your resource's base address, such as `https://YOUR-RESOURCE.cognitiveservices.azure.com`, without adding an API path. Verwrity uses the prebuilt Read model. |
| Google Cloud Vision | Use `https://vision.googleapis.com/v1/images:annotate` and a key enabled for Cloud Vision. This is distinct from Google's Document AI service. |

For hosted OCR you only need the photo/video import packages, rather than the large local model packages:

**Windows PowerShell**

```powershell
venv\Scripts\python.exe -m pip install -e ".[ocr-import]"
```

**Linux, macOS or WSL**

```sh
venv/bin/python -m pip install -e '.[ocr-import]'
```

The next subsection covers local installation. If you're using a hosted provider, you can go straight to [recognising and reviewing pages](#recognising-and-reviewing-pages).

#### Installing local OCR

Stop Verwrity before installing. These commands install local OCR support, explicitly download the olmOCR model and check whether PyTorch can see a CUDA GPU. The model download itself needs internet access; recognising your pages afterwards doesn't.

**Windows PowerShell**

```powershell
venv\Scripts\python.exe -m pip install -e ".[local-ocr]"
$env:HF_HUB_DISABLE_TELEMETRY = "1"
venv\Scripts\python.exe -c "from huggingface_hub import snapshot_download; snapshot_download('allenai/olmOCR-2-7B-1025', local_dir='user_files/models/olmocr2')"
venv\Scripts\python.exe -c "import torch; print(torch.cuda.is_available()); print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU only')"
```

**Linux or WSL**

```sh
venv/bin/python -m pip install -e '.[local-ocr]'
HF_HUB_DISABLE_TELEMETRY=1 venv/bin/python -c "from huggingface_hub import snapshot_download; snapshot_download('allenai/olmOCR-2-7B-1025', local_dir='user_files/models/olmocr2')"
venv/bin/python -c "import torch; print(torch.cuda.is_available()); print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU only')"
```

In **AI Models**, choose the local provider and point it at `user_files/models/olmocr2`, or use Verwrity's own download controls instead of the manual download command. You can choose a different folder for existing model files. A complete download needs the model's configuration, processor and weights, not just one weight file. Verwrity won't download missing files during recognition.

Allow substantial disk space and memory. olmOCR's weights are roughly 17 GB, and loading it on CPU can need around 34 GB of memory for the weights alone. Paddle's download is smaller, around 2 GB, but its integration is experimental; don't assume it will produce the same results as its full upstream pipeline. Try a representative page before committing to a long batch.

If you've chosen CUDA but the check prints `False` or `CPU only`, first check that you have a supported NVIDIA GPU and driver. You may have installed a CPU build of PyTorch. The following commands replace Torch and Torchvision with a matching CUDA 12.8 pair; use them only if that is appropriate for your system. Check the [official PyTorch installation instructions](https://pytorch.org/get-started/locally/) if you need a different platform or CUDA build.

**Windows PowerShell**

```powershell
venv\Scripts\python.exe -m pip install --force-reinstall torch==2.11.0 torchvision==0.26.0 --index-url https://download.pytorch.org/whl/cu128
venv\Scripts\python.exe -m pip check
venv\Scripts\python.exe -c "import torch, torchvision; print('Torch:', torch.__version__); print('CUDA runtime:', torch.version.cuda); print('CUDA available:', torch.cuda.is_available()); print('GPU:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'unavailable'); print('GPU calculation:', torch.ones(4, device='cuda').sum().item())"
```

**Linux or WSL**

```sh
venv/bin/python -m pip install --force-reinstall torch==2.11.0 torchvision==0.26.0 --index-url https://download.pytorch.org/whl/cu128
venv/bin/python -m pip check
venv/bin/python -c "import torch, torchvision; print('Torch:', torch.__version__); print('CUDA runtime:', torch.version.cuda); print('CUDA available:', torch.cuda.is_available()); print('GPU:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'unavailable'); print('GPU calculation:', torch.ones(4, device='cuda').sum().item())"
```

The final check should report CUDA as available, name the GPU and print `4.0` for the calculation. If `pip check` reports a conflicting optional Torch package, resolve that version conflict before restarting Verwrity. A download or successful import alone doesn't prove that recognition is using the GPU.

The optional sample test can check that a model loads and returns text. It isn't a speed estimate for a full manuscript page. The first real page may take longer while the model loads; later pages can reuse it. On CPU, allow minutes rather than assuming the interface has frozen. Status messages tell you what stage it's at, but can't promise an exact finish time. Cancel stops the local worker and releases its model memory, which means the next run must load it again.

#### Recognising and reviewing pages

Choose **Run OCR for checked pages** when you've selected the captures you want to process. You can also enable **Review each page with the LLM after OCR** to ask the text model for correction after recognition. That second step receives the recognised text and saved Project words, not the page image. It can repair likely mistakes, but it can't look at the paper to prove what an unclear letter says. Keep the image beside the result and check it yourself.

Online text correction needs its own consent, separately from permission to upload images to an OCR provider. If correction fails, the raw OCR remains available and you can retry correction without recognising the image again. Adding Project words can help with names and unusual terms, but doesn't rerun anything until you ask.

For each page, keep the raw result or choose the reviewed correction, editing your review where needed. Approval records your choice; it doesn't insert it yet. **Approve all ready pages** uses available results for pages without a choice while preserving choices you've already made, and doesn't start another paid review.

When you're ready, **Insert approved pages** adds checked, approved pages that haven't already been inserted, in thumbnail order, as one undoable manuscript change. Pages are separated by paragraph breaks. Verwrity doesn't decide how to join a sentence across pages, remove every header or split your manuscript into scenes, so check page boundaries, hyphens and headings as part of your review. If you find a missing page later, choose the right manuscript position before inserting it.

Changing or rerunning OCR after insertion doesn't revise manuscript text you've already accepted. If an insertion is interrupted, inspect the manuscript before trying again. Undoing an insertion doesn't automatically make the same pages eligible for a second insertion, so check the tool's status as well as the manuscript before proceeding.

#### Keeping or clearing an OCR session

This browser keeps captures, OCR results, review edits, approvals and insertion records for recovery. They're separate from your project archive. Reopening the tool doesn't automatically resume model calls. Keep the original photos or video yourself, and use the text download for a portable copy of the recognised writing. Clearing browser data can remove this recovery material.

**Clear / start fresh** removes the current OCR buffer after confirmation. Stop active work and download anything you need first. It doesn't remove text already inserted into the manuscript or your saved provider settings. The duplicate threshold returns to its starting value for the new session.

### Logging and troubleshooting

If a feature won't start, check that you installed its optional package into the environment you're actually running, then restart Verwrity. Check the selected provider, model path or service address in **AI Models**. Local models need complete files and enough memory; online services may need a valid key, available credit and permission for the exact configured address.

The server terminal reports progress and useful failure information without including manuscript text, recordings or API keys in Verwrity's logs. Don't paste private settings files into a public issue. When reporting a problem, the action you took, the message shown and whether you were using a local or hosted provider are usually more useful than a copy of your writing.

If the server connection is lost, keep the browser tab open and restart the server. The connection dialog can recover without a page reload. Don't refresh unsaved writing to fix a connection problem. Retry any failed wiki or named-project save once the server is back; see the recovery section below.

## Project files and recovery

### What is stored today

Your named projects and recovery files live under `user_files/` in the Verwrity folder. User settings, dictionaries, keys and downloaded models live there too, but aren't all part of the portable project. The current local user is called `local-user`; this isn't a password-protected account system.

If you want to locate those files for a backup or to move computers, the layout is:

```text
user_files/
  <user>/                       # currently local-user
    <title>.verwrity.zip           # named projects
    drafts/<project-id>/
      current.verwrity.zip
      previous-1.verwrity.zip
      previous-2.verwrity.zip
    preferences.json            # manuscript appearance and annotation display
    spelling_dictionary.json    # user-wide accepted words
    text_analyses.json           # custom reviews, built-in overrides, styles
    ai_models.json              # provider configuration and API secrets
    ai_models/kokoro-v1.0/       # explicitly downloaded TTS assets
    ai_models/whisper/           # explicitly downloaded STT model cache
```

Back up project archives and any separate recordings or OCR originals you want to keep. Treat the settings directory as private because it can contain credentials. Copying a project archive gives you the story; copying browser recovery data is a separate matter.

### Portable archive contents

**Export project** downloads a `.verwrity.zip` with readable text and JSON files. You can open the ZIP without Verwrity to recover the writing. It includes scenes, wiki pages, comments, history, dialogue labels, Project words and any optional world records.

If you're looking inside an archive, these are the main files:

```text
manifest.json                # format version, project ID, title
project_words.json           # human-approved shared vocabulary
scene_changes.json           # explicit split/join relationships
project_features.json        # project-scoped mode and optional tool choices
world_maps.json              # map identities, names and initial location links
fingal_source.json           # original Fingal bundle, source name and checksum, or null
manuscript.txt               # generated readable view of current scenes
scenes.json                  # canonical prose, metadata, comments, revisions
wiki.json                    # pages, world records, authorship/evidence and history
storyboard.json              # custom columns and scene-cell values
spelling_dictionary.json     # project-specific accepted words
```

The current format is version 10; older versions 1–9 can still be imported, with missing newer fields starting empty or disabled. Provider keys, personal appearance settings, model downloads, generated read-aloud audio, browser dictation/OCR buffers and temporary AI answers aren't included.

Imports have size limits to avoid opening an unexpectedly large archive: 25 MiB compressed, 20 MiB per member, 64 MiB expanded and 32 members. Upload overhead can make the practical HTTP limit slightly smaller than 25 MiB. If an archive is rejected, keep the original and read the error before changing anything; deleting writing to guess at the cause isn't a good recovery strategy.

### Working heads, named saves, and recovery

The current editable version of a scene is sometimes called its **working head**. It means the writing you're working on now, rather than an older checkpoint. There are several ways to keep that work, each useful for a different reason:

| What you use | What it gives you |
|---|---|
| Automatic recovery draft | A recent working snapshot if you leave without a named save or something interrupts the session. |
| **Save project** | An updated named project in the local library, ready to open next time. |
| **Export project** | A portable archive you can copy elsewhere as a backup or move to another computer. |
| **Manuscript backup → Download .txt** | Your current manuscript in an ordinary text file, easy to read without Verwrity. |
| **Versions → Record revision** | A checkpoint of one scene for comparison or restoration while you revise. |
| Wiki **History** | Earlier versions of a particular wiki page. |

Save regularly, export backups and keep copies somewhere other than the Verwrity folder. Recovery is helpful, but it isn't a long-term backup system or a complete record of every keystroke.

Verwrity keeps a current recovery draft and two fallback snapshots for each project. If there's newer recoverable work when you open a saved project, it asks which version to use. Read that choice carefully. Continuing from recovery lets you inspect the newer work and save it; discarding recovery chooses the named saved copy. If you're unsure which you need, keep the recoverable work long enough to inspect and back it up.

Renaming a project updates its named library entry. Duplicating makes a separate project; open that copy when you want to work on it. Importing an archive opens it with recovery protection, but you should save it under a name to keep it in the library.

If another tab has changed the project, Verwrity may refuse your save rather than overwrite newer work. Copy unsaved writing somewhere safe before opening the latest version and deciding which changes to keep. Avoid editing the same project in several tabs at once.

If the server stops, leave the tab open, restart the server and let the connection dialog reconnect. Scene autosave can retry, but failed wiki edits and named saves may need your explicit retry. If a save still fails, copy your text before reloading. A failed save isn't a backup, even when the writing is still visible on screen.

## Dialogue, scene structure and plain-text backups

Dialogue labels link spoken passages to character wiki pages. You can add them yourself or use **Analysis → Dialogue speakers** to propose labels for the current scene. Review and accept those proposals before they become saved labels; the model doesn't rewrite speech or establish new character facts. Speaker filters start with character pages, with an option to choose another wiki page when needed.

The per-speaker review helps you read a character's dialogue together and listen for a consistent voice. Scene split and join tools let you change the structure of the manuscript while keeping history available. These operations deserve a little care, particularly around comments and dialogue crossing a split. See [Dialogue and scene operations](DIALOGUE_AND_SCENES.md) for the controls and examples.

**Manuscript backup → Download .txt** includes the current manuscript, scene titles and descriptions, including unsaved text in the active scene. It doesn't include wiki notes, removed scenes or older revisions, and downloading it doesn't update your named project save. Keep a full project export alongside it when you want those other parts of the story as well.
