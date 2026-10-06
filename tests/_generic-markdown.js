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

Cause A.

Code references:

https://github.com/a/a/blob/abcdef0/c/d/e.js#L100-L110

### Attack Scenario

Foo \`code\` --> something happens --> something else happens

### Steps to Reproduce in the browser

1. Step 1
2. Step 2 text
   continuation of step 2.

### Impact

Impact A.

### Patch

Fix A.

## 2. BBB-05

### Title

[Product B] Long title B.

### Description

Description B.

### Root Cause

Cause B.

#### Code references:

https://github.com/a/b/blob/abcdef0/c/d/e.js#L100-L110
https://github.com/a/b/blob/abcdef0/f/g/h.js#L10-L20

### Attack Scenario

Scenario B.

### Steps to Reproduce in the browser

1. Reproduce B.

### Impact

Impact B.

### Patch

Fix B.
`
