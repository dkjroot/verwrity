# Dictation, OCR and speed reading

You have many options for how to get your story into Verwrity. You can type it in, read it aloud or bring it in from paper. Dictation and OCR need their own AI model setup, but all are possible offline using local models.

There's also a speed reading mode if you want to read your manuscript through that way. It's kind of a random feature, but it's my tool and I thoght it was cool! The speed reader mode needs no AI model.

[Quick dictation](#quick-dictation) · [Dictate draft](#dictate-draft-and-audio-imports) · [OCR](#import-written-pages-with-ocr) · [Speed reader](#speed-reader) · [Project words](#project-words)

## Quick dictation

Set up **AI Models → Speech-to-text** first. Faster Whisper runs offline once its optional support and complete model folder are installed. You can choose your own folder or download a model in settings. CPU with int8 is a useful starting point if CUDA isn't available (i.e. if you haven't got a powerful graphics card). You can also use a local or remote transcription server if you choose.

Click in the manuscript, wiki content, question box or wiki instruction field. Hold **Right Ctrl** while you speak and release it to transcribe. Double-press **Right Ctrl** to latch recording on, then press again to stop. There's also a microphone button on the UI wherever voice dictation is availble. In this immediate mode, a recording stops after five minutes.

You will need to allow microphone access in your browser. If you use a remote transcription service (optional), it will receive your recorded audio and recognition settings, but not manuscript or wiki context.

The transcript goes at the cursor position you started from, without replacing selected text. You can undo manuscript insertion. Dictating a wiki page leaves it unsaved, and dictating a question or instruction doesn't send it until you click send.

If you edit or switch fields while recognition is running, Verwrity keeps the transcript for you instead of guessing where to put it. Copy it, or choose a new position and use **Insert here**. Copy it before closing the tab if you want to keep it.

For a long recording or a phone voice note, use [Dictate draft](#dictate-draft-and-audio-imports). For photos or video of written pages, use [OCR import](#import-written-pages-with-ocr).

## Dictate draft and audio imports

Open **Scene tools → Dictate draft** when you want to read a longer piece aloud or import a recording (I use an app on my phone, then import the voice note). Choose a manuscript cursor position first. Check the displayed speech-to-text and cleanup providers, then choose **Start recording**, **Pause recording**, **Resume recording** or **Finish recording** as needed.

The recording is split into sections at quiet points or after about 45 seconds, and each snippet is converted to text for you to review.

**Import audio file** accepts WAV, MP3, M4A/MP4, AAC, FLAC, Ogg/Opus, WebM, AIFF, WMA, AMR and 3GP, up to 24 MiB per file. Longer recordings are split automatically; there's no separate duration limit. Conversion stays local and leaves your original file alone. Completed sections are kept if you cancel or a later stage fails.

You can keep the raw transcript or ask an LLM to clean it up. Cleanup tries to recover plausible spoken wording from imperfect recognition, including punctuation, paragraphing and small mishearings. You can choose whether to keep the 'raw' text-to-speech output or the 'cleaned up' version. **Model had no notes** means the raw text is available unchanged.

LLM cleanup uses your saved Project Words. Add any extra words for this dictation in the comma-separated field. To manage the saved list or scan your manuscript for suggestions, open **Settings → Word lists**.

Choose **Keep raw** or **Use reviewed cleanup** for each section; the choice is ticked and you move to the next. **Auto-approve all** uses completed cleanup where available, otherwise raw text, while keeping choices and edits you've already made. It's available after processing finishes.

**Insert approved sections** adds all the approved sections in recording order as one undoable edit. Use **Hide dialog to choose manuscript caret location** if you want to pick a destination for the text, then reopen the panel.

The insertion confirmation has **Clear recordings** checked by default. After a successful insertion is recorded, it clears this dictation's audio, transcripts and review text, including any unapproved sections. Uncheck it if you want to keep the buffer so that you can come back to the dialog to do more work on it.

## Import written pages with OCR

Open **Scene tools → Import manuscript pages (OCR)** to turn photos or a video of written pages into text you can review. First choose a local model or online provider in **Settings → AI Models → OCR**. The sample JPEG test is optional. The feature reference in user-guides has separate Windows and Linux installation commands.

olmOCR 2 is the local default. In my real-page trial it took roughly 30 seconds a page on my GPU once running and the output quality was good, but that isn't a promise for your pages or computer. CPU mode works, but it will be slow - leave your computer running and eventually you should get a result. PaddleOCR-VL-1.6 and handwriting recognition are experimental. I'd recommend you start with a small batch and compare it carefully with the paper copy to tune your settings before you go for a big OCR job.

Online choices are Mistral OCR, Azure Document Intelligence Read and Google Cloud Vision document OCR, using your own account and API key. **Online OCR sends selected manuscript page images off your computer to the configured provider, outside Verwrity's control.** Give permission for that exact endpoint in AI Models, then confirm sending images in the import dialog. Text correction needs separate permission. A local model won't silently fall back to an online one.

Import your video first, then check the thumbnails against your paper. Choose the video orientation, uncheck any repeated matches, reorder pages and add any missing photos or video frames. Likely repeats are automatically unchecked at a similarity threshold you can change (75% by default). The scores help you compare captures, but can't tell you whether every page is present. It will often detect a hand covering the page (while you flip to the next) as a different page, so there is some manual work to do.

**Show unchecked thumbnails** lets you hide likely repeats. Previous/Next capture beside the large preview lets you scroll through nearby unchecked images. Choose **Keep this capture instead** to swap your checked image. The most recent video is available while the tab stays open. After reloading, select the original video again to find a missing frame.

Preview crop and rotation before you run the OCR. **Image processing profile** allows you to adjust brightness, contrast, sharpness, size and colour mode. Start with a longest edge of 1288 px for olmOCR and check faint letters and punctuation. Preview one page, then apply the profile to that page or all uninserted pages.

Run OCR once you're happy with the captures. The progress bar shows the page, stage, elapsed time and token counts when available, so that you can see that something is happening during this slow process. Completion ticks mean OCR finished, not that you've approved the text. CPU models can take several minutes per page. **Cancel** stops the local worker and keeps completed results; an online request already sent may still finish and incur a charge.

Keep raw text, use a proposed correction, or edit and approve each page yourself. Bulk approval keeps choices you've already made. **Insert approved pages** is a separate, undoable action, in thumbnail order. If you forgot to set the insert point, hide the dialog to choose a new manuscript cursor position, then reopen it. You will need to review all the OCR text manually, it is very likely there will be mistakes.

## Speed reader

If you want to work on your reading speed, choose **Speed reader** above the manuscript, or from **Workspace** when the toolbar is hidden. This mode shows a word or a small group of words at a time against a black background. It includes unsaved text in your current scene and leaves your writing, selection, undo history and layout alone.

Choose where to **Start**: at your current cursor position, at beginning of the current scene or right from the beginning of the manuscript. Choose whether to **End** at the current scene or manuscript end. Click **Play**, use **Space** to pause/resume, and **Escape** or **Exit** to return to writing.

**Words** sets the group size to display at a time (1–20), and **Speed** sets 30–2,000 words per minute. **Flash (ms)** controls how long each appearance lasts; **Repeats** shows the same group more than once during its allotted time. More repeats don't increase the reading speed. For example, one word at 240 WPM lasts 250 ms; two 50 ms flashes appear at the start and halfway through, with blank gaps. The theory is that persistence of vision is part of speed reading and worth training.

**Some Speed Reader settings produce flashing text. Avoid them if you're sensitive to flashing graphics.**

## Project words

You will inevitably have special words in your project, names, places, sci-fi terms. You can add these to your project words, so that they won't be identified as spelling errors and will be passed to your AI models for more accurate voice recognition etc. Open **Settings → Word lists**.

**Scan saved manuscript** in **Settings → Word lists** checks your manuscript for unfamiliar words so that you can choose which should be in your project words list.

**Create wiki pages for selected words** creates empty pages only where no existing title or alias matches.

Your project words are stored in your project archive.
