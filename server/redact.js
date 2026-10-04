// Briefs and committed Fleet data travel (copied, emailed, sent to Claude, pushed to git), so
// people's details are stripped first.

export function redact(s) {
  return String(s ?? '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    // Phone numbers: a leading + or (area) and separated groups — never digits inside an id.
    .replace(/(?<![\w-])(?:\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,4}|\(\d{2,4}\)\s?\d{3}[\s-]\d{3,4})(?![\w-])/g, '<phone>')
    .replace(/(https?:\/\/[^\s"'?]+)\?[^\s"']*/g, '$1?…');
}

