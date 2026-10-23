<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Architecture rules
- Simulation lives in `src/lib/sim` as pure, deterministic TS (seeded); policies receive only `PolicyView` (forecast published at the current step) so they can never read future actuals — mirrors the challenge's fair-play rule.
- Residency is checked in the engine: any illegal deploy attempt disqualifies the run (score 0), matching the challenge rule.
- Live-run API calls go through the `exoGet` server function (EXO2-HMAC signing, read-only GET); credentials are passed per call and never stored.
- Sample workload/zone data in `src/lib/sim/data.ts` stands in for the starter kit; replace it rather than adding a second data source.
