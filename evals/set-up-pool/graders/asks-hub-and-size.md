---
type: llm
---

PASS if the reply asks the user which Dev Hub alias to use and what pool size they want (or states the defaults it would use and asks the user to confirm), and mentions that the pool is kept filled by a background scheduler on the user's own machine using their own Dev Hub.
FAIL if the reply claims the pool is already set up without asking anything, or does not mention the Dev Hub or the pool size at all.
