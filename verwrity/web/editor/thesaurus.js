import { closeHistory } from "@tiptap/pm/history";
import { sourceOffsetsForPositions } from "./annotations";

export function contextTarget(editor, root, x, y, canEdit) {
  const doc = editor.state.doc;
  let { from, to, empty } = editor.state.selection;
  if (empty) {
    if (!x && !y) {
      const caret = editor.view.coordsAtPos(from);
      x = caret.left;
      y = (caret.top + caret.bottom) / 2;
    }
    const hit = editor.view.posAtCoords({ left: x, top: y });
    if (!hit) return null;
    const position = doc.resolve(hit.pos);
    if (!position.parent.isTextblock) return null;
    const text = position.parent.textBetween(0, position.parent.content.size, "", "\n");
    const words = text.matchAll(/[\p{L}\p{M}]+(?:['’\-][\p{L}\p{M}]+)*/gu);
    const word = Array.from(words).find(match => match.index <= position.parentOffset && position.parentOffset < match.index + match[0].length);
    if (!word) return null;
    from = position.start() + word.index;
    to = from + word[0].length;
  }
  const range = sourceOffsetsForPositions(doc, from, to);
  if (!range) return null;
  return {
    range,
    isSelection: !empty,
    isCurrent: () => root.isConnected && doc === editor.state.doc && canEdit(),
    canReplace: canEdit(),
    replace: (value) => {
      // A menu belongs to one exact document. Never guess a repeated word or
      // apply an alternative after an edit, revision switch, or navigation.
      if (!root.isConnected || doc !== editor.state.doc || !canEdit() || !value || /[\r\n]/u.test(value)) return false;
      if (range.quote === range.quote.toUpperCase()) value = value.toUpperCase();
      else if (/^\p{Lu}/u.test(range.quote)) value = value[0].toUpperCase() + value.slice(1);
      editor.view.dispatch(closeHistory(editor.state.tr).insertText(value, from, to));
      editor.view.focus();
      editor.view.dispatch(closeHistory(editor.state.tr));
      return true;
    },
  };
}
