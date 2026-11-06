# Python version (legacy)

The first version of the analysis. The TypeScript tools in `../../analysis-ts/` replaced it and produce the same
outputs (checked on several nights). These scripts stay here because some features exist only in Python so far:

| Script | What | TypeScript |
|---|---|---|
| `analyze.py --plot`, `ppg.py --plot` | PNG plots of a night / of the PPG beats | outputs without plots |
| `audio.py` | phone recording as a reference for breathing, snoring and pauses | not ported |
| `breath_hold.py` | breath-hold test evaluation | not ported |
| `nights.py` | table across several nights (A/B tests) | not ported |
| `ppg_probe.py` | first look at an unknown raw sensor | not ported |
| `simulate.py` | synthetic test night with matching audio | not ported |

```
pip install -r legacy/python/requirements.txt
python legacy/python/analyze.py sessions/<session> --plot
```
Run them from the repository root. Details per script: `docs/manual.md`.
