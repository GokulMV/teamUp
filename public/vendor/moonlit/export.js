/* trees.js declares `const Trees` at the top level of a classic script: visible to other scripts but not
   as window.Trees. This tiny script hands it to the module that loaded it. */
window.Trees = typeof Trees !== "undefined" ? Trees : undefined;
