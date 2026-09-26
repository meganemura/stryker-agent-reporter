# stryker-agent-reporter

[Stryker](https://stryker-mutator.io/) 用の、コーディングエージェント向け reporter。
[JSON Lines](https://jsonlines.org/) を書く。
エージェントが手を打てる mutant 1 件につき 1 行、summary 1 行、そして実行の途中でも読める partial file を書く。

## インストール

```bash
npm install --save-dev stryker-agent-reporter
```

## 設定

```json
{
  "reporters": ["clear-text", "agent"],
  "plugins": ["@stryker-mutator/*", "stryker-agent-reporter"]
}
```

Stryker の `plugins` の既定値は `@stryker-mutator/*` だけを読み込む。
`stryker-agent-reporter` を `plugins` に足すと、Stryker は `agent` reporter も読み込む。

## 出力

reporter は既定で `reports/mutation/agent.jsonl` に書く。
各行は `kind` フィールドを持つ。
最初に `run` の行が 1 つ来る。
次にエージェントが手を打てる mutant の行が、1 件につき 1 行続く。
次に、どの mutant も殺せなかったテストの行が 1 行ずつ続く。
最後に `summary` の行が 1 つ来る。
各フィールドの詳細は [docs/output.md](docs/output.md) を参照。

## 実行の途中でも読む

最終ファイルは実行が終わったときに 1 回だけ書かれる。
それより前は、隣にある partial file(`reports/mutation/agent.partial.jsonl`)を読む。

```bash
tail -f reports/mutation/agent.partial.jsonl
```

## 保存済みの report を変換する

`stryker-agent-reporter convert` は、保存済みの `reports/mutation/mutation.json` を、`agent` reporter がその実行で書いたはずの JSON Lines ファイルに変換する。
`agent` reporter を設定せずに実行した report が手元にあるときに使う。

## pull request をゲートする

`stryker-agent-reporter gate` は、`agent.jsonl` を pull request 向けの合否判定に変える。
変更した行だけに絞る。

```bash
npx stryker-agent-reporter gate --since origin/main --format github
```

| 終了コード | 意味 |
| --- | --- |
| `0` | 手を打つべきものが無い。 |
| `1` | 生き残った mutant か、カバーされていない mutant が残っている。 |
| `2` | 使い方の誤り: 読めないファイル、未知のフラグ、`--since` での git の不在や不明な ref。 |
| `3` | 未検証の mutant、または `--since` が絞れなかったファイルがある。計測の失敗であり、証明された穴ではない。 |

`gate` と `convert` の入出力の全体は [docs/output.md](docs/output.md) を参照。

## ライセンス

Apache-2.0

---

[English](README.md)
