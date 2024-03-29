'use strict';

const { splitLines } = require('../utils/file');

/**
 * Get the content of a JSDoc-like comment and remove all surrounding asterisks, etc.
 * If the comment only contains whitespace it is seen as empty and `null` is returned
 * which also stops doc comment propagation.
 *
 * @param {string} comment Raw comment, e.g. '/** comment ... '.
 *                         Must be a valid doc comment.
 * @returns {string|null} Parsed contents or if the comment has an invalid format or
 *                        does not have any content, null is returned.
 */
function parseDocComment(comment) {
  // Also return "null" for empty doc comments so that doc comment propagation
  // can be stopped.
  if (comment.length <= 5) // at least "/***/"
    return null;

  let lines = splitLines(comment);

  if (lines.length === 1) {
    // special case for one-liners
    // remove "/***/" and trim white space
    const content = lines[0].replace(/^\/[*]{2,}/, '').replace(/\*\/$/, '').trim();
    return isWhiteSpaceOnly(content) ? null : content;
  }

  lines[0] = removeHeaderFence(lines[0]);
  lines[lines.length - 1] = removeFooterFence(lines[lines.length - 1]);

  if (isFencedComment(lines)) {
    lines = lines.map((line, index) => ((index === 0) ? line : removeFence(line)));
  }
  else if (lines.length === 2) {
    // Comment that is essentially just a header + footer.
    // First line, i.e. header, is always trimmed from left.
    lines[0] = lines[0].trimLeft();

    // If the second line starts with an asterisk then remove it.
    // Otherwise trim all whitespace.
    if ((/^\s*[*]/.test(lines[1])))
      lines[1] = removeFence(lines[1]);
    else
      lines[1] = lines[1].trimLeft();
  }
  else {
    const firstNonEmptyLine = lines.find((line, index) => index !== 0 && /[^\s]/.test(line)) || '';
    // Tabs are regarded as one space.
    const spacesAtBeginning = firstNonEmptyLine.match(/^\s*/)[0].length;
    if (spacesAtBeginning > 0)
      lines = lines.map(line => removeWhitespace(line, spacesAtBeginning));
  }

  // Remove empty header and footer.
  const startIndex = (lines[0] === '') ? 1 : 0;
  const endIndex = (lines[lines.length - 1] === '') ? lines.length - 1 : lines.length;

  const content = lines.slice(startIndex, endIndex).join('\n');

  return isWhiteSpaceOnly(content) ? null : content;
}

/**
 * Checks whether the given string is whitespace only, i.e. newline
 * spaces, tabs.
 *
 * @param {string} content
 */
function isWhiteSpaceOnly(content) {
  return content.trim().length === 0;
}

/**
 * Remove the "fence" around a single comment line.
 * A fence consists of one asterisks ('*') at the beginning with optional spaces
 * before the first '*' and one optional space after that. Spaces at the end of
 * the line are never removed.
 *
 * @param {string} line
 * @returns {string} line without fence
 */
function removeFence(line) {
  return line.replace(/^\s*[*]\s?/, '');
}

/**
 * Remove the TODO
 *
 * @param {string} line
 * @param {number} spaces Number of whitespace to remove at the beginning of the line
 * @returns {string} line without fence
 */
function removeWhitespace(line, spaces) {
  return line.replace(new RegExp(`^\\s{0,${ spaces }}`), ''); // Trailing spaces with '*'? => .replace(/\s+[*]$/, '');
}

/**
 * Removes a header fence, i.e. '/**'.
 * May remove more than two asterisks e.g. '/*******'
 *
 * @param {string} line
 * @returns {string} Header without fence.
 */
function removeHeaderFence(line) {
  return line.replace(/^\/[*]{2,}\s?/, '');
}

/**
 * Remove trailing '*\/'. The following cases can happen:
 *   ' * end comment *\/'    => ' * end comment'
 *   '   end *********\/'    => 'end'
 *   '   *************\/'    => removed
 *
 * @param {string} line
 * @returns {string} header without fence
 */
function removeFooterFence(line) {
  return line.replace(/\s*[*]+\/$/, '');
}

/**
 * Returns true if the source lines all start with an asterisk.
 * Header (i.e. first entry in "lines" array) is ignored.
 *
 * @param {string[]} lines
 */
function isFencedComment(lines) {
  const index = lines.findIndex((line, index) => {
    const exclude = (index === 0 || index === lines.length - 1);
    return !exclude && !(/^\s*[*]/.test(line));
  });
  return index === -1 && lines.length > 2;
}

module.exports = {
  parseDocComment,
};
