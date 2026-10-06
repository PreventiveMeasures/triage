export const genericMarkdown = `| # | ID | Product | Priority | Vulnerability |
|---:|---|---|---|---|
| 1 | AAA-02 | Product A | P0 | Title A. |
| 8 | BBB-05 | Product B | P2 | Title B. |

## 1. AAA-02

### Title

[Product A] Long title A.

### Description

Description A.

### Root Cause

https://github.com/a/a/blob/abcdef0/c/d/e.js#L100-L110

### Steps to Reproduce in the browser

1. Step 1
2. Step 2 text
   continuation of step 2.

### Patch

Fix A.

## 2. BBB-05

### Title

[Product B] Long title B.

### Root Cause

https://github.com/a/b/blob/abcdef0/c/d/e.js#L100-L110
https://github.com/a/b/blob/abcdef0/f/g/h.js#L10-L20
`
