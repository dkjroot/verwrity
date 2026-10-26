# Licensing

Copyright in the project's original contributions belongs to Dave (GitHub: [`dkjroot`](https://github.com/dkjroot)) and the respective contributors. Third-party authors retain copyright in their own work.

Except for separately identified third-party components and assets, this project's original code and documentation are free software: you may redistribute them and/or modify them under the **GNU General Public License, version 3** (`GPL-3.0-only`), published by the Free Software Foundation. The complete license is in [license.txt](license.txt). The software is provided without warranty; see that license for details. This notice grants version 3, without an "or any later version" option.

## The maintainer's request and your legal rights

The README asks people to keep the software freely available, avoid profiting from paid copies or services built around it, use the official GitHub repository, and send voluntary development support directly to the maintainer. These are requests, not added license conditions. Commercial use, charging for copies, lawful forks, and redistribution remain permitted by GPLv3. Recipients keep their license rights; donations and maintainer approval are not prerequisites.

When conveying covered software, comply with the GPL's applicable notice, licensing, and corresponding-source requirements. A GitHub link alone is not necessarily enough for a binary distribution. Merely running a hosted service does not by itself trigger the GPL's source-distribution requirements. See the [GNU licensing FAQ](https://www.gnu.org/licenses/gpl-faq.html).

Third-party packages, data, media, model weights, and external services retain their own terms. A dependency's license label or this document does not replace its actual license. Preserve all applicable copyright notices, license texts, attributions, and any required source or change notices when redistributing them. Optional external services may charge users independently of this free software.

## Your writing belongs to you

The GPL covers Verwrity's application code. It does not cover an author's original manuscript, wiki text, story structure, project archive, or document export merely because Verwrity was used to create, edit, save, or export it. Verwrity claims no ownership of those works. Authors can keep them private, choose their own terms, publish them, and sell them without paying the maintainer or sharing their work's source. The README request to keep Verwrity free concerns the software, not books or other works made with it. Existing rights in third-party inputs, quotations, assets, and material produced through separately licensed services still apply.

GPLv3 section 2 distinguishes running a program from licensing its output: [the license text](https://www.gnu.org/licenses/gpl-3.0.html#section2).

## Libraries and bundled data

The browser editor uses MIT-licensed Tiptap, ProseMirror, pagination, and their runtime dependencies. Full package copyright/permission notices are retained in [third_party/browser-editor-licenses.txt](third_party/browser-editor-licenses.txt). The root [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) also covers the Python stack and optional speech engines. The spelling and thesaurus datasets retain their own permissive notices under `verwrity/analysis/data/`.

Optional speech packages can include LGPL FFmpeg, LGPL edge-tts, or other native components. They are not relicensed as Verwrity code. If packaging those runtimes, retain their notices and provide corresponding source/relinking rights where required; audit the exact wheel, codecs, libraries, and model assets shipped. FFmpeg's license depends on how it was built. A source checkout with optional dependencies installed separately is not a clearance for every bundled installer.
