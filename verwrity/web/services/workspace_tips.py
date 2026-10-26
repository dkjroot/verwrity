"""Local, editorial workspace hints and optional developer support links."""

from dataclasses import dataclass
from collections.abc import Mapping
from urllib.parse import urlsplit


@dataclass(frozen=True)
class SupportLink:
    label: str
    url: str


@dataclass(frozen=True)
class WorkspaceTip:
    title: str
    body: str
    kind: str = "tip"
    links: tuple[SupportLink, ...] = ()
    help_topic: str = ""


TIPS = (
    WorkspaceTip("Focus on with the writing", "Typewriter Mode locks the cursor while you draft. Useful if you can't resist revising.", help_topic="focus"),
    WorkspaceTip("Your wiki can know more than your reader", "Keep your secrets, background and plans in the wiki.", help_topic="wiki"),
    WorkspaceTip("One character, several names", "Add alternative titles to a wiki page for nicknames, aliases, and titles. Verwrity can recognise those names as links in your manuscript.", help_topic="wiki"),
    WorkspaceTip("Try a different scene order", "Open Go to Storyboard and rearrange the sticky notes. Your text, notes and history move with each scene.", help_topic="storyboard"),
    WorkspaceTip("What do you want this scene to do?", "Use Scene metadata to jot down viewpoint, narrator, time, place and purpose.", help_topic="scene-metadata"),
    WorkspaceTip("Future you will deal with it", "Select manuscript text to add a comment. Tick the TODO option while adding it to copy your note to the TODO page in the wiki.", help_topic="comments"),
    WorkspaceTip("Keep a version before the big edit", "Choose 'Versions → Record revision' before trying a rewrite. You can compare it later and bring earlier writing back without losing the versions in between.", help_topic="revisions"),
    WorkspaceTip("Get to know a character", "On a wiki page, 'Insert form → Character profile' adds questions you can answer to help with character development.", help_topic="wiki"),
    WorkspaceTip("Another opinion, if you want one", "Analysis modes offer spelling and optional AI scene reviews. Read the suggestions and decide what you agree with.", help_topic="analysis"),
    WorkspaceTip("Ask about your own story", "Use the question box below the manuscript to ask about your story and wiki. Follow the passage links to check the answer against what you've actually written.", help_topic="questions"),
    WorkspaceTip("Keep a backup", "'File operations → Export' downloads a portable .verwrity.zip.", help_topic="projects"),
    WorkspaceTip("Links in your notebook", "Use [[Page title]] in wiki content to connect pages. Backlinks show which other pages point to the one you are reading.", help_topic="wiki"),
    WorkspaceTip("Special words?", "Add all your invented words and names in Settings → Word lists. They won't show up in the spell check, and AI tools will understand them too.", help_topic="dictionaries"),
    WorkspaceTip("Check your the voice across your story", "'Manuscript tools → Narrative voice consistency' asks your model to review all your scenes to advice on consistence of your narrative voice. As usual, you don't have to accept any of its advice!", help_topic="tasks"),
    WorkspaceTip("Try listening to it", "Set up Text-to-speech in AI Models, then choose Read scene. Kokoro speaks locally; online voice services receive the text you ask them to read.", help_topic="read-aloud"),
    WorkspaceTip("Speak a thought into the page", "Set up Speech-to-text, then click in your manuscript, wiki or question. Hold Right Ctrl while you speak and release to transcribe. Escape cancels.", help_topic="dictation"),
    WorkspaceTip("Think up your own analysis modes", "Add a custom scene review prompt in Analysis. Each detector has its own highlight colour and style.", help_topic="analysis"),
    WorkspaceTip("Dictate your whole scene", "'Scene tools → Dictate draft' lets you import longer recordings and phone voice notes.", help_topic="dictate-draft"),
    WorkspaceTip("Bring your paper pages into the story", "'Scene tools → Import manuscript pages (OCR)' reads photos or video captures and turns them into text.", help_topic="ocr-import"),
    WorkspaceTip("Build your reading speed", "Speed reader mode shows one word or a small group at your chosen pace.", help_topic="speed-reader"),
)


def support_links(config: Mapping[str, object]) -> tuple[SupportLink, ...]:
    """Only render explicit web links; never invent account or campaign URLs."""
    links = []
    for key, label in (("SUPPORT_PATREON_URL", "Patreon"),
                       ("SUPPORT_COFFEE_URL", "Buy Me a Coffee"),
                       ("SUPPORT_KICKSTARTER_URL", "Kickstarter")):
        url = str(config.get(key) or "").strip()
        try:
            parsed = urlsplit(url)
            if (parsed.scheme != "https" or not parsed.hostname or parsed.username
                    or parsed.password or any(character.isspace() for character in url)):
                continue
            parsed.port  # Reject malformed ports before presenting the link.
        except ValueError:
            continue
        links.append(SupportLink(label, url))
    return tuple(links)


def workspace_tips(config: Mapping[str, object]) -> tuple[WorkspaceTip, ...]:
    support = WorkspaceTip(
        "Finding Verwrity useful?",
        "If you fancy buying me a coffee, I'd really appreciate it. It helps me keep working on Verwrity. There's no obligation to contribute; I'm glad you're using it.",
        kind="support", links=support_links(config), help_topic="support",
    )
    # Support is a regular part of the deck, with three useful hints between asks.
    deck = []
    for index, tip in enumerate(TIPS):
        deck.append(tip)
        if (index + 1) % 3 == 0:
            deck.append(support)
    return tuple(deck)
