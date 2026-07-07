"""Build a demo fast-rlm session over a (synthetic, Lex-Fridman-style) podcast
corpus, asking questions designed to accumulate rich, reusable REPL memory —
an index, a helper function, and several committed variables with notes.

Great for showing off `fast-rlm-log <dir> --tui` (query timeline + drill-down)
and the `m` memory inspector.

    RLM_MODEL_API_KEY="$RLM_MODEL_API_KEY_2" \
        uv run python scripts/session_demo_lex.py [OUTPUT_DIR]

Costs real API money (OpenRouter gemini-3.5-flash by default). The corpus is
synthetic: real guest names and plausible framing, invented quotes.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import fast_rlm  # noqa: E402

MODEL = os.environ.get("RLM_DEMO_MODEL", "google/gemini-3.5-flash")
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(__file__), "..", "sample_logs", "lex_session")
OUT = os.path.abspath(OUT)

CONFIG = {
    "primary_agent": MODEL,
    "max_money_spent": 0.60,
    "max_calls_per_subagent": 20,
    "max_depth": 1,
}

# ── Synthetic corpus: (episode, guest, date, topics, quotes) ─────────────
# Invented quotes; real names/framing for demo flavor only.
EPISODES = [
    (351, "Andrej Karpathy", "2023-01-12", ["neural nets", "AGI", "self-driving"], [
        "I think we'll have systems that feel genuinely intelligent within five to seven years.",
        "The bitter lesson is real: scale and general methods keep winning over clever priors.",
        "Self-driving is a fantastic testbed because the real world refuses to be tidy.",
    ]),
    (367, "Ilya Sutskever", "2023-03-27", ["AGI", "alignment", "scaling"], [
        "AGI could arrive surprisingly soon; I would not be shocked by the end of the decade.",
        "Alignment is the most important technical problem we have to get right.",
        "Prediction of the next token, done well enough, is a path to understanding.",
    ]),
    (375, "Yann LeCun", "2023-05-02", ["world models", "AGI", "open source"], [
        "Autoregressive LLMs are a dead end for real reasoning; we need world models.",
        "Human-level AI is probably decades away, not years. People overestimate progress.",
        "Open research and open models are how the field stays healthy.",
    ]),
    (388, "Demis Hassabis", "2023-07-14", ["AGI", "science", "reinforcement learning"], [
        "I think AGI is maybe a decade or two out, and it will transform science first.",
        "AlphaFold showed that AI can make real scientific discoveries, not just predictions.",
        "Games were always a means to an end — the end is general intelligence.",
    ]),
    (399, "Yoshua Bengio", "2023-09-01", ["alignment", "safety", "deep learning"], [
        "I have become much more worried about AI safety in the last two years.",
        "We need governance now; the timelines for powerful AI may be short.",
        "Consciousness in machines is not required for them to be dangerous.",
    ]),
    (405, "Sam Altman", "2023-10-19", ["AGI", "AI policy", "startups"], [
        "AGI is coming, and probably sooner than most people are comfortable with.",
        "Iterative deployment lets society co-evolve with the technology.",
        "The economics of intelligence too cheap to meter will reshape everything.",
    ]),
    (416, "Jeff Hawkins", "2023-12-05", ["neuroscience", "world models", "intelligence"], [
        "The neocortex builds thousands of models of the world in parallel.",
        "True intelligence needs a body-like reference frame, not just text.",
        "I don't think scaling language models alone gets you to understanding.",
    ]),
    (428, "Chris Olah", "2024-02-09", ["interpretability", "alignment", "neural nets"], [
        "Interpretability is the microscope the field has been missing.",
        "We are starting to find real, human-understandable features inside models.",
        "If we can read what a model is thinking, alignment gets much more tractable.",
    ]),
    (441, "Fei-Fei Li", "2024-04-22", ["computer vision", "AI policy", "science"], [
        "AI is a civilizational technology; human-centered design must lead.",
        "ImageNet worked because data at scale unlocked what algorithms could not.",
        "Spatial intelligence is the next frontier after language.",
    ]),
    (455, "Max Tegmark", "2024-06-30", ["safety", "AGI", "physics"], [
        "We could reach superintelligence within years if capabilities keep compounding.",
        "The window to install safety guardrails is closing faster than people think.",
        "Intelligence is substrate-independent — that's both the promise and the peril.",
    ]),
]


def format_corpus() -> str:
    lines = ["LEX FRIDMAN PODCAST — TRANSCRIPT EXCERPTS", ""]
    for num, guest, date, topics, quotes in EPISODES:
        lines.append(f"### Episode {num} — {guest} ({date})")
        lines.append(f"Topics: {', '.join(topics)}")
        for q in quotes:
            lines.append(f'  "{q}"')
        lines.append("")
    return "\n".join(lines)


def build_queries():
    """The demo's queries as natural user questions. Only the first supplies the
    corpus; every follow-up is phrased the way a person would actually ask it —
    no variable names, no 'in your REPL', no commit() instructions. Reusing the
    memory it built (instead of re-deriving or asking for the corpus again) is
    left to the agent. That's the point: it tests recall, not instruction-following."""
    corpus = format_corpus()
    return [
        ("overview of the guests",
         "I'm going to ask you a series of questions about these Lex Fridman "
         "Podcast guests, so get yourself organized first — set up whatever will "
         "help you answer follow-ups efficiently without me re-sending this. "
         "Below are the transcript excerpts (guest, date, topics, memorable "
         "quotes). Once you're set up, give me a clear overview: who are the "
         "guests, and in one sentence each, what is the core idea that guest is "
         "known for here?\n\n" + corpus),

        ("who's optimistic vs skeptical on AGI",
         "Across these conversations, where do the guests land on how soon AGI "
         "arrives? Tell me who is optimistic about the near term and who thinks "
         "it's much further off, with a word on why for each."),

        ("group into camps",
         "Group these guests into a few natural camps based on what they most "
         "care about, and tell me who falls into each camp."),

        ("who to have back",
         "Which of these guests would be most worth having back for a debate "
         "specifically about AI safety? I'm after the ones who take safety "
         "seriously AND think powerful AI is coming soon."),

        # ── Long-form: a natural ask that produces a multi-paragraph answer. ──
        ("long-form essay (long output)",
         "Write me a sharp ~400-word essay on the disagreement over AGI timelines "
         "among these guests. Name names, give the strongest version of each "
         "side's argument, and end on where the safety worries concentrate."),

        # ── Follow-up that consumes the previous long-form answer. ──
        ("takeaways from the essay",
         "Nice. Now pull out the five sharpest one-line takeaways from that "
         "essay, each tied to a specific person."),
    ]


def main():
    s = fast_rlm.Session(session_dir=OUT, config=CONFIG,
                         verbosity="summary", log_dir=os.path.join(OUT, "logs"))

    queries = build_queries()
    already = len(s.queries())  # resume: skip queries this session already ran
    if already:
        print(f"Resuming: {already} quer{'y' if already == 1 else 'ies'} already "
              f"in the session; running the remaining {len(queries) - already}.")

    for i, (label, prompt) in enumerate(queries):
        if i < already:
            print(f"Q{i + 1}: {label} — already done, skipping.")
            continue
        print(f"Q{i + 1}: {label} …")
        r = s.query(prompt)
        res = r["results"]
        preview = res if isinstance(res, (int, float, list)) else str(res)
        if isinstance(preview, str) and len(preview) > 200:
            preview = preview[:200] + f"… [{len(res)} chars]"
        print("   FINAL:", preview)

    print("\nDone. Session at:", OUT)
    print("View it:")
    print(f"  uv run fast-rlm-log {OUT} --tui     # timeline + drill-down + 'm' for memory")
    print(f"  uv run fast-rlm-log {OUT}           # text summary")


if __name__ == "__main__":
    main()
