# project-starter

このリポジトリはスターターなので、プロダクトそのものは存在しません。

ハーネスはまだ実装中で、使える状態にはなっていません。

## スターターからプロジェクトを始める

3ステップです。

```bash
# 1. クローンして、履歴を切る
git clone <this-repo> my-project
cd my-project
rm -rf .git && git init

# 2. プロジェクト名を変える
#    package.json の name を、自分のプロジェクト名にする

# 3. インストール
pnpm install
```

`pnpm install` は `prepare` フック経由で `scripts/init.mjs` を実行します。これがやること:

- スターター自身のチケットを消す
- ハーネスから `closed` の build を落とす
- 全 build の `note` を「スターターから継承」に書き換える
- `product` を空にする（`name` だけ `package.json` から取る）
- `spec/initialized.json` を書く（2回目以降は走らせないため）

手順2の前に実行すると、名前を先に変えるよう案内して止まります。

`pnpm install` を再実行しても init は走りません。pnpm は `node_modules` が最新だと `prepare` を呼ばないためです。名前を変えたあとは、`node scripts/init.mjs` を手で実行してください。

## ハーネスを最新に保つ

スターターは更新され続けます。その変更をプロジェクトに取り込むには、**スターター側で**実行します。

```bash
node scripts/apply.mjs /path/to/my-project          # dry-run。何が変わるかを表示するだけ
node scripts/apply.mjs /path/to/my-project --run    # 適用
```

ハーネスだけをコピーし、`spec/product/`、`spec/tickets/`、`.git/` 以下には触りません。`AGENTS.md` は更新され、`README.md` は更新されません。

コピーはファイル単位の丸ごと置き換えです。`spec/harness/v001.json` は全 build を1ファイルに持つため、行ベースのマージでは別々の build を編集していても衝突します。スクリプトはマージを試みません。気に入らなければ `git diff` で確認し、`git restore` で戻してください。

## どこに何があるか

`spec/` がプロジェクトの現在の状態を表し、正本になります。

- `spec/README.md` — モデルと、その背景にある原則
- `spec/build.md` — build とは何か
- `spec/ticket.md` — ticket とは何か
- `spec/cli.md` — spec の書き方

spec の JSON を手で編集しないでください。書くのは `spec/cli/index.ts` だけで、書き込みの前に必ず検証が走ります。
