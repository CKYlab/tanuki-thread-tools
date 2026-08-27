# tanuki-thread-tools

雑談たぬきの閲覧を便利にする非公式ユーザースクリプト。

## Features

- 分割されたスレッドを1ページに全レス表示
- アンカー先レスをマウスオーバーでポップアップ
- 展開済みスレッドをHTMLとして保存
- 雑談たぬき本来のデザインを維持

## Requirements

ユーザースクリプトマネージャーが必要です。

動作確認:
- Chrome + Violentmonkey
- Brave + Violentmonkey

Firefox系ブラウザでも、標準的なUserScript環境で動作する構成です。

## Install

[ユーザースクリプトをインストール](https://raw.githubusercontent.com/CKYlab/tanuki-thread-tools/main/tanuki-thread-tools.user.js)

## Usage

1. `tanuki-thread-tools.user.js` をユーザースクリプトマネージャーへ登録
2. 雑談たぬきのスレッドを開く
3. 右上の「全レス表示」をクリック
4. 全レス取得後はアンカー先ポップアップとHTML保存が利用可能

## Notes

- アンカー先ポップアップは現在ページに読み込まれているレスが対象です。
- 「全レス表示」実行後はスレッド内の全レスが対象になります。
- 全レス表示時は複数ページを順番に取得します。ボタンを連打しないでください。
- サイト側の仕様変更により動作しなくなる場合があります。
- PCからの書き込み制限を回避する機能はありません。

## Disclaimer

本スクリプトは非公式ツールです。
雑談たぬきの運営者・管理者とは関係ありません。
