"""RLM memory demo: the complete Sherlock Holmes canon, then follow-up questions.

The point of this example is *memory*, not long context. The first query hands
the agent all nine books (~660k words / ~900k tokens) and asks it to get
organized. Every question after that sends **no corpus at all** — just a plain
follow-up, the way a person would ask it. The agent answers from the index and
helper functions it built in query 1, which the session restored into a fresh
REPL.

    # one-time: fetch the public-domain texts (Project Gutenberg)
    uv run python examples/sherlock_memory.py --download

    # run the demo
    uv run python examples/sherlock_memory.py [OUTPUT_DIR]

Costs real API money. Resumable: re-run the same OUTPUT_DIR and it skips the
questions already answered.

Inspect what it remembered:
    uv run fast-rlm-log <OUTPUT_DIR> --tui     # timeline; press 'm' for memory
"""
import os
import re
import sys
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import fast_rlm  # noqa: E402

MODEL = os.environ.get("RLM_DEMO_MODEL", "google/gemini-3.5-flash")
HERE = os.path.dirname(os.path.abspath(__file__))
CORPUS_DIR = os.environ.get(
    "SHERLOCK_DIR", os.path.join(HERE, "..", "data", "sherlock"))
CORPUS_DIR = os.path.abspath(CORPUS_DIR)

CONFIG = {
    "primary_agent": MODEL,
    "max_money_spent": 1.50,
    # The catalogue-style questions fan out to many subagents that each quote
    # the text; the 50k default trips on them.
    "max_completion_tokens": 250_000,
    "max_calls_per_subagent": 25,
    "max_depth": 1,
}

# Project Gutenberg ids for the canon, in publication order.
BOOKS = [
    (244, "01_a_study_in_scarlet", "A Study in Scarlet", 1887),
    (2097, "02_the_sign_of_the_four", "The Sign of the Four", 1890),
    (1661, "03_the_adventures_of_sherlock_holmes", "The Adventures of Sherlock Holmes", 1892),
    (834, "04_the_memoirs_of_sherlock_holmes", "The Memoirs of Sherlock Holmes", 1894),
    (2852, "05_the_hound_of_the_baskervilles", "The Hound of the Baskervilles", 1902),
    (108, "06_the_return_of_sherlock_holmes", "The Return of Sherlock Holmes", 1905),
    (3289, "07_the_valley_of_fear", "The Valley of Fear", 1915),
    (2350, "08_his_last_bow", "His Last Bow", 1917),
    (69700, "09_the_case_book_of_sherlock_holmes", "The Case-Book of Sherlock Holmes", 1927),
]


def download() -> None:
    os.makedirs(CORPUS_DIR, exist_ok=True)
    for pg_id, slug, title, _year in BOOKS:
        path = os.path.join(CORPUS_DIR, slug + ".txt")
        if os.path.exists(path) and os.path.getsize(path) > 10_000:
            print(f"  have {title}")
            continue
        url = f"https://www.gutenberg.org/cache/epub/{pg_id}/pg{pg_id}.txt"
        print(f"  fetching {title} …")
        with urllib.request.urlopen(url) as r:
            text = r.read().decode("utf-8", "replace")
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
    print(f"Corpus in {CORPUS_DIR}")


def strip_gutenberg(text: str) -> str:
    """Drop the Project Gutenberg license header/footer, keep the book."""
    start = re.search(r"\*\*\*\s*START OF TH(E|IS) PROJECT GUTENBERG.*?\*\*\*", text)
    if start:
        text = text[start.end():]
    end = re.search(r"\*\*\*\s*END OF TH(E|IS) PROJECT GUTENBERG", text)
    if end:
        text = text[:end.start()]
    return text.strip()


def load_corpus() -> str:
    missing = [t for _i, s, t, _y in BOOKS
               if not os.path.exists(os.path.join(CORPUS_DIR, s + ".txt"))]
    if missing:
        sys.exit(f"Missing {len(missing)} book(s) in {CORPUS_DIR}.\n"
                 f"Run: python {sys.argv[0]} --download")
    parts = []
    for _pg_id, slug, title, year in BOOKS:
        with open(os.path.join(CORPUS_DIR, slug + ".txt"), encoding="utf-8") as f:
            body = strip_gutenberg(f.read())
        parts.append(f"===== BOOK: {title} ({year}) =====\n\n{body}")
    return "\n\n".join(parts)


def build_queries(corpus: str):
    """Query 1 carries the whole canon and asks the agent to get organized.
    Queries 2-6 carry nothing but the question — no corpus, no variable names,
    no 'use your REPL' hints. Whether they're answered from memory or by
    re-deriving from scratch is the agent's call, and that's what the demo
    is measuring."""
    return [
        ("set up + overview",
         "I'm going to ask you a series of questions about the complete Sherlock "
         "Holmes canon, so get yourself organized first — set up whatever will "
         "help you answer follow-ups efficiently without me re-sending this text. "
         "Below are all nine books in publication order, each marked with a "
         "'===== BOOK: ... =====' header. Once you're set up, give me an "
         "overview: what are the nine books, how many stories does each contain, "
         "and what's the title of each story?\n\n" + corpus),

        ("Watson's wound",
         "Where exactly was Watson wounded in the war? Doyle isn't consistent "
         "about this — show me every passage that mentions the wound and tell me "
         "how they conflict."),

        ("Moriarty's footprint",
         "How much of Moriarty is actually on the page? List every story he "
         "appears in or is mentioned in, and say whether he's present in the "
         "scene or only talked about."),

        ("the disguises",
         "Holmes goes undercover a lot. Give me a compact table of his disguises "
         "across the whole canon — story, who he pretended to be, who he fooled. "
         "One short line each, no long quotes."),

        ("cocaine over time",
         "Track Holmes's drug use across the canon in publication order. When is "
         "it introduced, when does Watson push back, and when does it disappear? "
         "Quote the key moments."),

        # Long-form answer, then a follow-up that consumes it.
        ("essay (long output)",
         "Write me a sharp ~500-word essay on how Watson changes as a narrator "
         "from A Study in Scarlet to The Case-Book. Cite specific stories, and be "
         "concrete about what shifts in his voice and his role."),

        ("takeaways from the essay",
         "Nice. Now pull out the five sharpest one-line takeaways from that "
         "essay, each tied to a specific story."),
    ]


def main():
    if "--download" in sys.argv:
        download()
        return

    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    out = os.path.abspath(args[0] if args else
                          os.path.join(HERE, "..", "sample_logs", "sherlock_session"))

    corpus = load_corpus()
    print(f"Corpus: {len(corpus):,} chars (~{len(corpus) // 4:,} tokens) "
          f"across {len(BOOKS)} books")

    s = fast_rlm.Session(session_dir=out, config=CONFIG,
                         verbosity="summary", log_dir=os.path.join(out, "logs"))

    queries = build_queries(corpus)
    already = len(s.queries())  # resume: skip questions this session already ran
    if already:
        print(f"Resuming: {already} of {len(queries)} questions already answered.")

    for i, (label, prompt) in enumerate(queries):
        if i < already:
            print(f"Q{i + 1}: {label} — already done, skipping.")
            continue
        sent = "full corpus" if i == 0 else f"{len(prompt)} chars, no corpus"
        print(f"Q{i + 1}: {label} … [{sent}]")
        r = s.query(prompt)
        res = r["results"]
        preview = res if isinstance(res, (int, float, list)) else str(res)
        if isinstance(preview, str) and len(preview) > 300:
            preview = preview[:300] + f"… [{len(str(res))} chars]"
        print("   FINAL:", preview)

    print("\nWhat it remembered:")
    for name, meta in s.variables().items():
        note = meta.get("note") or meta.get("comment") or ""
        print(f"  {name}: {meta.get('type')} {note}".rstrip())
    for name in s.functions():
        print(f"  {name}()  [function]")

    print("\nDone. Session at:", out)
    print(f"  uv run fast-rlm-log {out} --tui     # timeline + 'm' for memory")


if __name__ == "__main__":
    main()
