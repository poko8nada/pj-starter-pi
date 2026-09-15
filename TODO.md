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
- **verify は「観測できる結果」の列（`string[]`）。** 散文1本にしない理由は後述（分割力）
- id は `<kind>-<対象>`。**kind の語彙は検証しない**（ガイドのみ）理由は後述
- `uses` は片方向・順序を強制しない
- **削除しない。`retiring` → `closed` → bump で落ちる**

### ticket = 作業

- verify できる単位。バーティカルスライス
- **1 build : 1 ticket / 1 build : N ticket / N build : 1 ticket** のどれもあり得る
- `targets` に「そのチケットが手を入れる build」を書く。**意味での取捨をしない**
  - リファクタでもバグ修正でも入れてよい。分母が増えて分子が増える、でよい
  - `condition: null` がそれ（触るが条件は進めない）。`[]` も許す
- 順序は持たせない（`verify` と `title` を読めば分かる。粗い依存は build の `uses` で表現）
- 消化したチケットは残す（消すと分母が減って progress が意味を失う）
- 起票は都度（まとめて洗い出してもよい。強制しない）

### 分割力の矯正（後から追加した論点）

**問題**: build と ticket が同じ形（`title` + 散文 verify）だと、両者が collapse して
**1build 1ticket にしかならない**。散文には継ぎ目が無いので、切ろうにも切れない。

**解決**: 継ぎ目を build 側の verify に作る。`verify` を**条件の列**にし、ticket が
「どの build の、どの条件を進めるか」を指す。

```json
// build
{ "id": "auth-login",
  "verify": ["有効な資格情報でセッションが発行される", "無効な資格情報では 401 が返る"] }

// ticket（統合形。`builds` と `advances` を分けない）
{ "id": "tkt-0001", "specType": "product",
  "targets": [{ "build": "auth-login", "condition": "無効な資格情報では 401 が返る" }],
  "title": "失敗系の分岐を実装",
  "verify": "空欄・形式不正・不一致の3パターンで 401 とエラー表示が出る",
  "status": "todo", "resolvedIn": null }
```

**統合する理由**: 分けて `builds` と `advances` にすると「この条件はどの build のものか」が
決まらない状態が書けてしまう。統合するとその検査自体が不要になる。

**`builds` は導出**（`targets.map(t => t.build)`）なのでフィールドごと消える。

**条件は文字列で指す**。index だと `verify` を並べ替えた瞬間に指す先が変わるため。

| 検証       | 内容                                                                      |
| ---------- | ------------------------------------------------------------------------- |
| 条件の一意 | 同一 build 内で `verify` が重複しない（build をまたぐ重複は許す）         |
| 参照解決   | `targets[].condition` がその build の `verify` に実在する                 |
| **上限**   | **1 ticket は同一 build につき条件1つまで**（＝同じ build を2回書けない） |
| null       | `condition: null` = 触るが条件は進めない（リファクタ・雑務）              |

**上限が分割の矯正**。2条件を1枚で片付けたければ、ticket を2枚に割るか、build を2つに割るか。
どちらでもいいが、**どちらかは必ず起きる**。

**副産物（一番大きい）**: 条件が列挙されるので以下が検査できる。

> `status: working` を宣言する build は、すべての条件が done な ticket から参照されていること。

`status` は宣言値のままだが、**根拠を要求できる**。適用範囲は「ticket が 1 件以上ある build」
に限る（hamess の 9 件は ticket 無しで working なので）。`retiring` / `closed` は対象外。

**代償**:

- 既存 9 件の `verify` を配列化する作業（`hook-lefthook` は2条件に割れる）
- cross-document（複数ファイルをまたぐ）検証は `parseSpec` に置けない（1ファイルしか見ない）
  → **`store.ts` を新設**して分離する

| モジュール             | 責務                                                               |
| ---------------------- | ------------------------------------------------------------------ |
| `schema.ts`            | 1ドキュメントの形（変更なし）                                      |
| **`store.ts`（新規）** | 現行 spec + tickets の読み込み、progress 算出、cross-document 検証 |
| `cli.ts`               | 引数解釈・表示・ディスパッチ（薄いまま保つ）                       |

### ticket のフィールド（仮）

```json
{
  "id": "tkt-0001",
  "specType": "product",
  "targets": [{ "build": "auth-login", "condition": "無効な資格情報では 401 が返る" }],
  "title": "ログインフォームのバリデーションを実装",
  "verify": "空欄と不正な形式でエラーが出て、正しい入力で送信できる",
  "status": "todo",
  "resolvedIn": null
}
```

| フィールド   | 内容                                                                        |
| ------------ | --------------------------------------------------------------------------- |
| `id`         | build と同じ形式検証が通る（`tkt-0001` 等）                                 |
| `specType`   | `product \| harness`。横断配置なので必須                                    |
| `targets`    | `{ build, condition }` の配列。`condition: null` は「触るが条件は進めない」 |
| `title`      | 何をするか                                                                  |
| `verify`     | 何をもって完了とするか。build の verify の条件を具体化                      |
| `status`     | `todo \| doing \| done`                                                     |
| `resolvedIn` | **機械が書く。** done になったときの現行バージョン番号。reopen で消える     |

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
progress(N, build X) = X を target に持つチケットのうち、
                       open であるもの + resolvedIn === N であるもの
total = その総数、done = うち status === "done"
```

`condition: null` の target も分数に入る（作業であることに変わりはない。
あなたの「分母が増えて分子が増える、それだけでいい」に従う）。

- ticket が0件なら **フィールドごと absent**（`0/0` とは書かない）
- **過去版の `progress` は凍結**。突き合わせ検証をしない（その時点のスナップショット）
- **bump で progress はリセットされる**（2ファイル式の帰結。既存の「working だが untracked」と同じ状態）

### チケットの保存

**層ごとにディレクトリを分ける。** product と harness で独立にバージョンが進むため、
1つの場所に混ぜると名前空間が衝突する（実測で確認。下の「見つかった穴」を参照）。

| 場所                                      | 中身                                        |
| ----------------------------------------- | ------------------------------------------- |
| `spec/tickets/<specType>/current.json`    | **open なチケットだけ**（`todo` / `doing`） |
| `spec/tickets/<specType>/archive/vN.json` | その層の vN の間に done になったもの        |

```
spec/tickets/
  product/
    current.json
    archive/v003.json     ← product の v003
  harness/
    current.json
    archive/v002.json     ← harness の v002
```

- **バージョンで括らない**（`v001` 用チケット、は作らない）。バージョンは「定義」の区切りであって作業の区切りではない
- **`specType` フィールドは削除する。** ディレクトリが層を表すので冗長になる
- **live ファイルの不変条件は「open な作業だけ」** → 行数が無限に増えない（`done.json` にしない理由）
- `progress` が読むのは層ごとに **2ファイル**（`current` + `archive/vN`）。バージョンが上がっても2固定
- done で**即アーカイブ**（bump 時ではない。bump は破壊的変更でしか起きず、それまで溜まる）
- 完了は in-place のステータス変更ではなく移動。失敗時は「重複」になり、`validate` が検出できる（ロストしない）

#### なぜ層で分けるか（実態）

|            | スターター   | プロジェクト       |
| ---------- | ------------ | ------------------ |
| プロダクト | ほぼ触らない | **ほぼ全部**       |
| ハーネス   | **ほぼ全部** | 一部（小さな変更） |

**触る対象がほぼ逆。** 混ぜると、触らない方のチケットを読んで振り分けることになる。
分ければ、読まない層は読まない。

1つのチケットが両層の build を指すケースは**現実には無いと判断**。レイヤーが違う作業
（ハーネスを直す / ページを作る）は、別々に起票する方が自然で、`targets` の完了条件も
1つの意味に保てる。

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

- [x] チケットの `id` 形式（`tkt-0001` か、番号のみか）
- [x] チケットの `status` 語彙（`todo / doing / done` の3つでよいか。`blocked` を入れるか）
- [x] `build:remove` を独立コマンドにするか、bump の GC に任せるか
      → **両方やる。** 独立コマンドを持つ（明示操作） + `bump` でも GC する（忘れても溜まらない）。
      同じ参照ガード（open チケット・`uses` が参照していれば拒否）を両方にかける
- [x] `archive/vN.json` のファイル名の付け方（`v001.json` でよいか。ただし**層ディレクトリの下**に置く）
- [x] reopen で過去版の progress が動く件（警告して許可、でよいか）
- [x] チケットを削除したときの `progress` 再計算（常に許可でよいか）
- [x] `retiring` の語彙が適切か（`deprecating` / `removing` 等）
- [x] `spec/harness` の build に `progress` を持たせるか（今は全部 absent）
- [x] `spec init` / フォーク手順（→ #10 で実装）
- [x] チケットを層で分けるか（→ #9 で実装。**分ける**）
- [x] `closed` の build を init でどうするか（→ **削除**）
- [x] `done.json` 1ファイルにするか（→ **しない**。`archive/vN` で live を小さく保つ）

---

## TODO（実装順）

### 1〜3. retiring / build:remove / verify 条件列 → 完了

### 4. チケット本体 → 完了

- [x] `lib/store.ts` を新設（現行 spec + tickets の読み込み、cross-document 検証）
- [x] `lib/ticket.ts`: Ticket の型・語彙・検証（`targets` の参照解決、`resolvedIn`）
- [x] `targets` の上限（同一 build につき条件1つ）を検証
- [x] `progress` の算出（`current` + `archive/vN`）
- [x] `status: working` の被覆検査（ticket が 1 件以上ある build のみ）
- [x] `cli/ticket.ts`: `ticket:add` / `ticket:set` / `ticket:remove` / `ticket:list`
- [x] `progress` の突き合わせ検証（現行版のみ）
- [x] テスト（110 件）

### 5. archive と `resolvedIn` → 完了

- [x] done で即アーカイブ（`archive/vN.json`）
- [x] reopen で `resolvedIn` を索引にして取り出す
- [x] `build:rename` が現行 archive も書き換える
- [x] `build:remove` の参照ガードが ticket も見る

### 6. ドキュメント → 完了

- [x] `spec/README.md`（索引） / `build.md` / `ticket.md` / `cli.md` に分割
- [x] `AGENTS.md` を圧縮（要約を削り、README へのリンクだけ残す）

### 7. 構造の整理 → 完了

- [x] `spec/lib`（概念ごと）/ `spec/cli`（役割ごと）に分割
- [x] `status` の入れ子を解消し、`note` を追加（build と ticket が同じ形に）

### 8. apply（スターター → プロジェクト） → 実装済み

- [x] `scripts/apply.mjs`。rclone でハーネスのみコピーする（**追跡外**: `.git/info/exclude`）
- [x] **dry-run を既定**にし、`--run` を明示させない限り書き込まない
- [x] 適用対象 / 除外を JS 側の定数で持つ（`INCLUDE` / `EXCLUDE` / `KEEP_LISTED` / `NEVER`）
- [x] `--delete` はオプトイン（`copy` / `sync` の切り替え。既定は `copy`）
- [x] `--with-listed` の仕組み（**`KEEP_LISTED` は今は空**。拡張点として残す）
- [x] `AGENTS.md` は既定で INCLUDE、`README.md` は除外
- [x] `--from` を廃止（適用元はスクリプトの親で固定）
- [x] `~` と相対パスを受け付ける（`expandHome`）
- [x] dry-run の表示は `--combined` + `--log-level ERROR`
- [x] **自分自身（`scripts/apply.mjs`）は配らない**（`EXCLUDE`）
- [x] 適用後にプロジェクト側の `sync-progress` を呼ぶ（`--type harness` を明示）

**git の merge は使えないと実測で確認。** JSON が1ファイルに複数 build を持つため、
別の build を触っていても行ベースで衝突する。merge driver は `.git/config` にしか
書けず clone で運べないので、配布物に組み込めない。→ ファイル単位で丸ごと置き換える
rclone を採用。JSON の中身を解釈しないことが利点になる。

### 9. チケットの層分離（見つかった穴の修正） → 完了

**穴**: `archive/vN.json` が層とバージョンで二重に衝突する。product が v003、harness が v002 のとき、
`v002` がどちらのものか決まらず、`current.json` も層を区別しないので、他層のチケットを
「存在しない build を参照」と判定してしまう（実測で確認）。

```
product 検証: archive/v003 を探す → 無い → done を数えない → progress 不一致
harness 検証: archive/v002 を読む → 中の page-home(product) を参照切れと判定
```

- [x] `lib/ticket.ts`: `ticketsFile(root, specType)` / `archiveFile(root, specType, version)`
- [x] `lib/ticket.ts`: `specType` フィールドを削除
- [x] `lib/store.ts`: `loadSnapshot` を層別に読む。`computeProgress` / `syncProgress` / `clearTickets`
- [x] `cli/ticket.ts`: `--type` が場所を決める
- [x] テストのフィクスチャを修正（110 件維持）
- [x] `spec/README.md` / `ticket.md` / `cli.md` の構造記述を更新

**維持したもの**:

- 過去バージョンの archive は読まない（bump で progress がリセットされる）
- `bump` での progress 再計算
- `resolvedIn`（置き場所と一致し、reopen の索引になる）

### 10. init → 実装済み

- [x] `scripts/init.mjs`（`prepare` から呼ばれる）
- [x] `spec/lib/store.ts`: `initializeProject` / `isInitialized` / `initializedMarker`
- [x] フォーク手順をリポジトリ直下の `README.md` に記載
- [x] `apply.mjs`: `KEEP_LISTED` は空配列。`AGENTS.md` は INCLUDE、`README.md` は除外

**init がやること**:

| #   | 対象                      | 処理                                                                |
| --- | ------------------------- | ------------------------------------------------------------------- |
| 1   | `spec/tickets/<層>/` 両層 | 全消去（`clearTickets`）                                            |
| 2   | `closed` の build         | 削除（参照が残っていれば拒否）                                      |
| 3   | 残った build の `note`    | 「スターターから継承」に書き換え                                    |
| 4   | product                   | `name` は `package.json` の name。`goal` / `nongoal` / `build` は空 |
| 5   | `progress`                | 再計算（チケット0件なので absent になる）                           |
| 6   | `spec/initialized.json`   | 印を書く                                                            |

**判定（順に見る）**:

1. `PROJECT_STARTER` 環境変数がある → skip（**スターター自身**）
2. `spec/initialized.json` がある → skip（**既に init 済み**）
3. `package.json.name` が空か `project-starter` → 案内して skip（**名前を先に変えさせる**）
4. それ以外 → 実行

**スターター自身の判定に環境変数を使った理由**: `product.name` も `package.json.name` も
クローン先と区別できない（どちらも `project-starter`）。`.envrc` は `.gitignore` 対象なので
クローン先には配られず、設定の有無だけで確実に区別できる。

**`initialized.json` を別ファイルにした理由**: `product/vN.json` に入れると `bump` が
引き継ぎを考慮する必要がある。バージョンと無関係なプロジェクト全体の状態なので、
`spec/` 直下に置いてバージョンの外に出した。

**`product.name` を判定に使わなかった理由**: 利用者が先に `product` の名前を変えると
「既に init 済み」と誤判定し、チケットや `note` が残ったままになる。`initialized` の
有無なら、名前をどう変えても init すべきかどうかを正しく判定できる。

### 11. 実運用で発見された問題への対処

## 実装中の発見（既知の割り切り）

- **過去バージョンの archive は読まない。** rename / remove は現行 archive にしか届かない。
  「現行版とチケットが整合しているか」を常に検証できるようにするための割り切り。
  `bump` のコメントに明記済み。
- **`build:set` で `--verify` を変えると、ticket が参照する条件が消えうる。**
  書く前に `assertCandidateAcceptable` が止めるので、参照切れは発生しない。
- **`--note` は消える操作（remove）と機械的操作（bump）には要らない。**
  残せないものに理由を要求しても記録にならないため。
- **apply は JSON を解釈しない。** ファイル単位で丸ごと置き換える。git のマージは、
  1ファイルに全 build を持つ JSON では行ベースで衝突するため使えない（実測済み）。
- **apply はハーネスにチケットがあるプロジェクトで `validate` が落ちる。**
  `progress` は正しく再計算されるが、スターターから来た `status: working` と、
  プロジェクトのチケット状況（未完了）が矛盾する。`init` はチケットを消すので起きない。
