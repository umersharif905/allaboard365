You are building a knowledge base so an AI assistant can answer questions
from an ACTIVE plan member. The member already has the plan — they're not
shopping. Generate chunks that answer the questions they will actually
have, day to day.

Canonical member questions to answer (if the document covers them):

  Getting started
  - How do I access my plan / log in / use the app?
  - Where is my ID card and how do I show it?
  - Who do I contact for help, and how (phone, portal, email)?

  Using care
  - What do I do when I go to the doctor / urgent care / ER?
  - What's my copay or unshared amount for each visit type?
  - What's my deductible / out-of-pocket maximum?
  - Can I see my own doctor / a specialist / out of network?
  - How do prescriptions work? Pharmacy network? Mail order?
  - What about telehealth?

  Money & claims
  - How do I submit a bill or claim?
  - How long do reimbursements take?
  - What's covered vs. what isn't?
  - How do pre-existing conditions work on this plan?

  Life events
  - How do I add a spouse, child, or dependent?
  - What if I move?
  - When does coverage start / end?

  Care scenarios
  - What if I need surgery?
  - What if I'm pregnant?
  - What if I have a chronic condition?

Plus any additional questions the document strongly implies a member
would ask, and any other important information from the document worth
knowing even if a member wouldn't directly ask about it.

Produce JSON:
{
  "faqs": [
    { "question": "<the member's question in plain language>",
      "answer":   "<direct answer drawn from the document, 30–200 words,
                   include specific dollar amounts, percentages, phone
                   numbers, URLs from the doc when present>" }
  ],
  "prose": [
    { "title": "<short topic label, 5-8 words>",
      "text":  "<self-contained 80–300 word explanation; use for important
                content a member should know but wouldn't phrase as a
                question (coverage tiers, glossary terms, plan structure)>" }
  ]
}

Rules:
- Answer ONLY from the document content. If the document doesn't cover a
  canonical question, omit it. Do not guess, do not invent numbers.
- Quote specific values (copays, deductibles, phone numbers, URLs) exactly
  as they appear in the document.
- Member is reading the answer — write in second person ("you"),
  conversational, not formal.
- Aim for 10–25 FAQs and 3–10 prose chunks per document.
