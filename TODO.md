# spec 設計メモと TODO

Claude との設計議論で決まったこと・決まっていないことの記録。

**このファイルは一時的なもの。実装が完遂したら削除する。**
確定した事項は `spec/README.md` に移し、ここからは消す。

---

## 現状（実装済み・コミット済み）

- `spec/schema.ts` — 語彙・型・検証・読み書き（唯一の I/O 窓口）
- `spec/cli.ts` — コマンド入口
- `spec/schema.test.ts` — 38 tests
- `spec/product/v001.json` — build 空
- `spec/harness/v001.json` — 9 build、すべて `working`
- `spec/tickets/` — `.gitkeep` のみ（未設計）
- `spec/README.md` / `AGENTS.md`

### CLI（実装済み）

```
validate / show / bump / build:add / build:set / build:rename
```

### 実装済みのガード

- 語彙外の `--type` / `--state` を拒否
- 未知フラグ・位置引数を拒否
- id 形式（小文字・ハイフン・2セグメント以上）
- id 重複、`uses` の参照切れ・自己参照
- `progress.total > 0`、`done <= total`
- 空文字を拒否、未知フィールドを拒否
- 検証失敗時はファイルを書かない
- `--version` で過去版を触ると警告
- `bump` は引数なし（現行+1）、build を引き継ぐ

### harness の id（移行済み）

`gate-quality` / `ext-sound-notify` / `script-typecheck-staged` / `hook-lefthook` /
`config-lint-format` / `config-test` / `ci-pullfrog` / `doc-agents` / `cli-spec`

---

## 確定した設計

### build と ticket の役割

|            | build                      | ticket                                   |
| ---------- | -------------------------- | ---------------------------------------- |
| 何を表すか | プロダクトが持つ**性質**   | そこへ**到達するための作業**             |
| 寿命       | **永続。バージョンで管理** | 達成したら役目を終える。**バージョン外** |
| 検証の主体 | **プロダクトを使う人**     | **作っている側**                         |

**この表がチケットの存在理由そのもの。** `spec/README.md` のチケット節冒頭に置く。

### build = 作るもの

- verify できる単位。バーティカルスライス
- id は `<kind>-<対象>`。**kind の語彙は検証しない**（ガイドのみ）理由は後述
- `uses` は片方向・順序を強制しない
- **削除しない。`retiring` → `closed` → bump で落ちる**

### ticket = 作業

- verify できる単位。バーティカルスライス
- **1 build : 1 ticket / 1 build : N ticket / N build : 1 ticket** のどれもあり得る
- `builds` に「そのチケットが手を入れる build」を全部書く。**意味での取捨をしない**
  - リファクタでもバグ修正でも入れてよい。分母が増えて分子が増える、でよい
  - 「verify に寄与するか」を判断させるのは余計な負荷。機械で検証できない規則は置かない
- 順序は持たせない（`verify` と `title` を読めば分かる。粗い依存は build の `uses` で表現）
- 消化したチケットは残す（消すと分母が減って progress が意味を失う）
- 起票は都度（まとめて洗い出してもよい。強制しない）

### ticket のフィールド（仮）

```json
{
  "id": "tkt-0001",
  "specType": "product",
  "builds": ["auth-login"],
  "title": "ログインフォームのバリデーションを実装",
  "verify": "空欄と不正な形式でエラーが出て、正しい入力で送信できる",
  "status": "todo",
  "resolvedIn": 1
}
```

| フィールド   | 内容                                                                    |
| ------------ | ----------------------------------------------------------------------- |
| `id`         | build と同じ形式検証が通る（`tkt-0001` 等）。※要確定                    |
| `specType`   | `product \| harness`。横断配置なので必須                                |
| `builds`     | **1件以上必須。** M:N を許す                                            |
| `title`      | 何をするか                                                              |
| `verify`     | 何をもって完了とするか。build の verify を具体化                        |
| `status`     | `todo \| doing \| done`（※要確定）                                      |
| `resolvedIn` | **機械が書く。** done になったときの現行バージョン番号。reopen で消える |

### state はライフサイクル

```
planned ──→ building ──→ working ──→ retiring ──→ closed
  始点                                             終点
```

- `planned` = プランだけ
- `building` = 作っている最中
- `working` = 完成して動いている。**維持する**
- `retiring` = **まだある。消す作業中**（新規追加）
- `closed` = **無くなった**（意味を狭めた。追跡終了ではない）

`retiring` が要る理由: 深く統合されたものの削除は1ステップではない（利用側の移行、呼び出し削除、
コード削除、設定削除）。**作業には居場所が要る。** これが `working` でも `closed` でも表現できない穴。

`flag` ではなく `state` にする理由:

- `retiring` は「かつて動いていた」を含意するので情報が失われない
- flag だと 4状態 × 2 の組み合わせが生まれ、大半が無意味
- 任意フィールドを全廃した原則と整合する

### 遷移の規則

> **起きたことを消す移動は禁止。**

禁止は `working / retiring / closed → planned` のみ。「一度作って動いたものが計画だけだったことになる」
のは記録の否定になるため。

| 移動                                | 可否  | 理由                                       |
| ----------------------------------- | ----- | ------------------------------------------ |
| 前進（飛ばすのも可）                | ○     | `planned → closed`（作らずにやめる）も正当 |
| `building → planned`                | ○     | 何も完成していないので消すものが無い       |
| `working → building`                | ○     | 作り直し                                   |
| `retiring → working`                | ○     | 撤去をやめる                               |
| `working/retiring/closed → planned` | **✗** | 起きたことを消す                           |
| `closed → 戻す`                     | ○     | reopen。明示操作として扱う                 |

`planned → retiring`（作っていないものが撤去中）は定義上おかしいが、**通してしまう**。
宣言値なので次に正しい状態を書けば直る。規則を1つ増やすよりよい。

### status と progress は独立した2軸

|            | 書く人             | 答えること                             | 検証                     |
| ---------- | ------------------ | -------------------------------------- | ------------------------ |
| `status`   | 人間かエージェント | この build は今どういう状態か          | 語彙と text のみ         |
| `progress` | ticket             | このプロジェクトで何件中何件終わったか | **現行版のみ突き合わせ** |

**導出しない。** starter の harness は ticket が無いので、導出すると `planned` と嘘をつく。
`progress` が下がっても `status` は宣言なので嘘にならない。**この独立が逃げ道になっている。**

`progress` が汚染・変動しても、`status` を主・`progress` を従として読む。

### progress の算出

```
progress(N) = build X を参照するチケットのうち、
              open であるもの + resolvedIn === N であるもの
total = その総数、done = うち status === "done"
```

- ticket が0件なら **フィールドごと absent**（`0/0` とは書かない）
- **過去版の `progress` は凍結**。突き合わせ検証をしない（その時点のスナップショット）
- **bump で progress はリセットされる**（2ファイル式の帰結。既存の「working だが untracked」と同じ状態）

### チケットの保存

| 場所                             | 中身                                        |
| -------------------------------- | ------------------------------------------- |
| `spec/tickets/current.json`      | **open なチケットだけ**（`todo` / `doing`） |
| `spec/tickets/archive/v001.json` | `resolvedIn: 1` のチケット                  |

- **1ファイル**（1チケット1ファイルにしない）
- **バージョンで括らない**（`v001` 用チケット、は作らない）。バージョンは「定義」の区切りであって作業の区切りではない
- **live ファイルの不変条件は「open な作業だけ」** → 行数が無限に増えない
- `progress(N)` が読むのは常に **2ファイル**（`current` + `archive/vN`）。バージョンが上がっても2固定
- done で**即アーカイブ**（bump 時ではない。bump は破壊的変更でしか起きず、それまで溜まる）
- 完了は in-place のステータス変更ではなく移動。失敗時は「重複」になり、`validate` が検出できる（ロストしない）

### bump の挙動

- `--to` **なし**。現行 + 1
- build を**引き継ぐ**（破壊的変更は「一部が変わる」ことで「全部消える」ことではない）
- **`closed` は落とす**（これが build リストの縮む唯一の瞬間）
- ただし **open なチケットが参照しているものは残す**（削除作業を事故で失わない）
- **落とした/残したを理由付きで報告する**（静かに消えない）

### なぜ kind の語彙を検証しないか

`trigger` enum で失敗したのと同じ罠に入るため。閉じた語彙は websites / SaaS / apps /
backends / frameworks / libraries を同時に覆えない。**形は矯正、意味はガイド。**

反面、`build-gate-quality` のような定数セグメントは**形式では弾けない**（`build` も1セグメント
に過ぎないため）。これは規約とエラー文のガイドでしか達成できない。既知の限界。

### その他（原則）

- **任意フィールドは書かれない。** 必須にして空（`[]` / 空文字）を許す
- **省略に意味があるものだけが派生値**（`progress` の absent がその唯一）
- **書かなくても分かることは書かない**（スタック、スキル一覧）。ただし依存は一目で分からないので書く
- 書き込みは必ずスクリプト経由

---

## 未決・要検討

- [ ] チケットの `id` 形式（`tkt-0001` か、番号のみか）
- [ ] チケットの `status` 語彙（`todo / doing / done` の3つでよいか。`blocked` を入れるか）
- [ ] `build:remove` を独立コマンドにするか、bump の GC に任せるか
- [ ] `archive/vN.json` のファイル名の付け方（`v001.json` でよいか）
- [ ] reopen で過去版の progress が動く件（警告して許可、でよいか）
- [ ] チケットを削除したときの `progress` 再計算（常に許可でよいか）
- [ ] `spec init` / フォーク手順（チケットの形が決まってから）
- [ ] `retiring` の語彙が適切か（`deprecating` / `removing` 等）
- [ ] `spec/harness` の build に `progress` を持たせるか（今は全部 absent）

---

## TODO（実装順）

### 1. `retiring` を追加

- [ ] `schema.ts`: `BUILD_STATES` に `retiring` を追加
- [ ] `cli.ts`: 遷移ガードを「`working/retiring/closed → planned` を拒否」に一般化
- [ ] `schema.test.ts`: 5状態、遷移のケースを追加
- [ ] `spec/README.md`: ライフサイクル図、`closed` の意味の変更、遷移規則
- [ ] `AGENTS.md`: state の語彙を更新

### 2. `bump` の closed 落とし

- [ ] `cli.ts`: `closed` を落とす。open チケット参照があれば残す
- [ ] 落とした/残したを理由付きで表示
- [ ] `schema.test.ts` / `spec/README.md` を更新

### 3. チケット本体

- [ ] `schema.ts`: Ticket の型・語彙・検証（`builds` の参照解決、`resolvedIn`）
- [ ] `schema.ts`: `progress` の算出（`current` + `archive/vN`）
- [ ] `cli.ts`: `ticket:add` / `ticket:set` / `ticket:done` / `ticket:reopen` / `ticket:list`
- [ ] `progress` の突き合わせ検証（現行版のみ）
- [ ] `spec/tickets/current.json` を作成
- [ ] テスト

### 4. archive と `resolvedIn`

- [ ] done で即アーカイブ（`archive/vN.json`）
- [ ] reopen で `resolvedIn` を索引にして取り出す
- [ ] `build:rename` が archive も書き換えるようにする
- [ ] `build:remove` の参照ガードを archive も見るようにする

### 5. ドキュメント

- [ ] `spec/README.md` のチケット節（build と ticket の表、粒度の問い、保存構造）
- [ ] `AGENTS.md` にチケットの存在を1行
