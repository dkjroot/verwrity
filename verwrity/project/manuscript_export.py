"""Readable backup projection; source prose remains unchanged."""


def plain_manuscript(project, *, include_scene_details=True):
    blocks = []
    for index, scene in enumerate(project.current_scenes(), 1):
        heading = "=" * 72 + f"\nScene {index}: {scene.title}\nDescription: {scene.summary}\n" + "=" * 72 + "\n\n" if include_scene_details else ""
        blocks.append(heading + scene.text)
    return "\n\n".join(blocks)
