# Four Looks

Type exact sentences with four face signals and a laptop camera. Built at SanD Hacks, Nov 14 to 15 2026.

## Setup

```bash
mkdir -p data/raw && cd data/raw
curl -sSLO https://data.imagineville.org/imagine/lm_mix_top3_2gram_abs0.0.arpa.gz
curl -sSLO https://www.aactext.org/imagine/aac_comm.zip && unzip -q aac_comm.zip && cd ../..
node tools/build-lm.mjs data/raw/lm_mix_top3_2gram_abs0.0.arpa.gz public/lm.json
node tools/eval.mjs dev
```

Data: the public AAC corpus and word model by Vertanen and Kristensson (EMNLP 2011), aactext.org/imagine.
