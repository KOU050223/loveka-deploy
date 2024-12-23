require('dotenv').config();
const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const ejs = require('ejs');
const path = require('path');
const admin = require('firebase-admin');
const functions = require('firebase-functions');
const sharp = require('sharp');// 画像処理用のモジュールをインポート
const { fileURLToPath } =require('url');
const { dirname } =require('path');

// 環境変数からサービスアカウントキーを取得
const serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS);

// Firebase Admin SDKを初期化
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// const __filename = fileURLToPath(import.meta.url);
// const __dirname = dirname(__filename);

const app = express();
const port = 3000;
app.set('view engine', 'ejs');
app.engine('ejs', ejs.__express);
app.set('views', path.join(__dirname,'views'));
app.use('/stylesheets', express.static(path.join(process.cwd(), 'stylesheets')));
app.use('/audio', express.static(path.join(__dirname, 'public/audio')));

// エラーハンドリング
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});

const db = admin.firestore();
const collectionRef = db.collection('responses');
const quiz = db.collection('quiz'); // Firestoreのクイズコレクションを取得
const imagetest = db.collection('imagetest'); // Firestoreの画像テストコレクションを取得

// LINE Messaging APIの設定
const config = {
  channelSecret: process.env.ChannelSecret,
  channelAccessToken: process.env.channelAccessToken
};

const client = new Client(config);

// ルートエンドポイント
app.get("/", (req, res) => {
  res.render("index");
});
//チュートリアルエンドポイント
app.get("/tutorial", (req, res) => {
  res.render("tutorial");
});


// Firestoreからランキングデータを取得する関数
async function getRankingData() {
  const snapshot = await collectionRef.orderBy('timestamp', 'asc').get();
  const rankingData = [];
  snapshot.forEach(doc => {
    const data = doc.data();
    rankingData.push({
      id: doc.id, // ドキュメントIDを含める
      message: data.message, // タイトルフィールドを含める
      timestamp: data.timestamp, // タイムスタンプフィールドを含める
      name: data.userName, //  ユーザーの名前を含める
      userid: data.userId
    });
  });
  return rankingData;
}

app.get("/calendar", async (req, res) => {
  try {
    // Node.js 側でデータをフェッチ
    const response = await fetch('https://24j3cw1b-3000.asse.devtunnels.ms/api/quiz-schedule'); // 外部 API へのリクエスト
    // レスポンスをテキストとしてログに出力
    const responseBody = await response.text();
    // JSONパースを試みる
    const quizData = JSON.parse(responseBody);
    res.render('calendar', { events: quizData });
  } catch (error) {
    console.error('Error fetching quiz schedule:', error);
    res.render('calendar', { events: [] }); // エラー時は空配列を渡す
  }
});

// 定期実行用のエンドポイント
app.get('/api/cron', async (req, res) => {
  // 問題文を現在時間に近い順で取得（過ぎたものは除く）
  const nextQuizData = await quiz.where('day', '>=', admin.firestore.Timestamp.now()).get();
  // 時間が過ぎているものを削除する
  const deleteQuizData = await quiz.where('day', '<', admin.firestore.Timestamp.now()).get();
  deleteQuizData.forEach(async (doc) => {
    await doc.ref.delete();
  });
  res.status(200).json({ message: `Cron job executed successfully${nextQuizData}` });
});

// ランキング表示
app.get("/ranking", async (req, res) => {
  try {
    const rankingData = await getRankingData();
    
    res.render("ranking", { rankingData });
  } catch (error) {
    console.error('Error getting ranking data:', error);
    res.status(500).send('Error getting ranking data');
  }
});

app.get('/api/ranking', async (req, res) => {
  const rankingData = await getRankingData();
  res.json(rankingData);
});

app.get('/api/quiz-schedule', async (req, res) => {
  try {
    const now = admin.firestore.Timestamp.now(); // 現在時刻をFirestoreのTimestampとして取得
    const snapshot = await db.collection('quiz')
      .where('day', '>=', now) // 現在時刻以降のデータを取得
      .get();

    if (snapshot.empty) {
      console.log('No matching documents.');
      return res.json([]); // データがない場合は空の配列を返す
    }

    const quizzes = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        title: data.question || 'Untitled Quiz',
        start: data.day.toDate(), // FirestoreのタイムスタンプをDateオブジェクトに変換
        answer: data.answer || 'No answer',
        type: data.type || 'text'
      };
    });

    res.json(quizzes); // クイズデータをJSONとして返却
  } catch (error) {
    console.error('Error fetching quiz schedule:', error);
    res.status(500).send('Error fetching quiz schedule: ' + error.message);
  }
});

// Webhookエンドポイントの設定
app.post('/webhook', middleware(config), (req, res) => {
  Promise
    .all(req.body.events.map(event => handleEvent(event)))
    .then(() => res.sendStatus(200))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// // 定期実行用のエンドポイント
// app.get('api/cron', async (req, res) => {
//   // 問題文を現在時間に近い順で取得（過ぎたものは除く）
//   const nextQuizData = await quiz.where('day', '>=', admin.firestore.Timestamp.now()).get();
//   res.status(200).json({ message: `Cron job executed successfully${nextQuizData}` });
// });

// サーバーを起動
app.listen(port, () => console.log(`Server is running on port ${port}`));


// クイズ関係の変数定義
let quizQuestion ="";
let quizAnswer ="";
let quizDate ="";
let quiztype ="";
let randomIndex = 0;

// 画像関係の変数定義
let isSaved = false;

// イベントを処理する関数
async function handleEvent(event) {
  console.log(`eventだよ: ${JSON.stringify(event, null, 2)}`); // 受信したイベントをログに出力
  // console.log(`event.message.text: ${event.message.text}`); // 受信したメッセージをログに出力
  if (event.type !== 'message') {
    return Promise.resolve(null);
  }

  const quizData = await quiz.get();
  const quizDataArray = quizData.docs.map(doc => doc.data());
  // console.log(`quizDataArray: ${JSON.stringify(quizDataArray, null, 2)}`);
  
  // クイズ関係処理まとめ
  switch (event.message.text) {
    case 'コマンド':
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'コマンド一覧です\nクイズ一覧\nクイズ作成\nクイズ教えて\n画像設定\n開催コンテスト'
      });
    case 'あそびかた':
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '遊び方のリンクです\nhttps://liff.line.me/2006601390-9yZjDbWP'
      });
    // case 'クイズ一覧':
    //   return client.replyMessage(event.replyToken, {
    //     type: 'text',
    //     text: 'クイズ一覧です：' + quizDataArray.map(quiz => quiz.question).join('\n\n')
    //   });
    case 'クイズ一覧':
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '開催されるクイズの一覧です\nhttps://liff.line.me/2006601390-ZjBan3Mq'
      });
    case 'クイズ作成':
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'クイズ作成を行います\nクイズの問題を入力してください\n【問題の書き方】\n問題：〇〇\n答え：〇〇\n終了日時：20xx/01/01 00:00'
      });
    case 'クイズ教えて':
      // ランダムにクイズを選択
      // randomIndex = Math.floor(Math.random() * quizDataArray.length);//quizDataArrayからランダムなクイズデータを取得
      // quizQuestion = quizDataArray[randomIndex].question;// ランダムに選ばれたクイズの質問を取得
      // quizAnswer = quizDataArray[randomIndex].answer;// ランダムに選ばれたクイズの答えを取得
      // quiztype = quizDataArray[randomIndex].type;// ランダムに選ばれたクイズのタイプを取得
      const _nextQuizDataSnapshot = await quiz
      .where('day', '>=', admin.firestore.Timestamp.now())
      .orderBy('day')
      .limit(1)
      .get();
    
      if (_nextQuizDataSnapshot.empty) {
        // クイズがない場合の処理
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '現在利用可能なクイズがありません。'
        });
      }
      
      const _nextQuizData = _nextQuizDataSnapshot.docs[0].data(); // 最初のクイズデータを取得
      quizQuestion = _nextQuizData.question;// ランダムに選ばれたクイズの質問を取得
      quizAnswer = _nextQuizData.answer;// ランダムに選ばれたクイズの答えを取得
      quiztype = _nextQuizData.type;// ランダムに選ばれたクイズのタイプを取得
      if(quiztype == 'audio')
      {
        // const audioname =quizDataArray[randomIndex].audioUrl;// ランダムに選ばれた音声ファイルの名前を取得
        const audioname =_nextQuizData.audioUrl;// ランダムに選ばれた音声ファイルの名前を取得
        const pestionaudio = 'https://4q79vmt0-3000.asse.devtunnels.ms/audio/' + audioname;// 音声ファイルの完全なURLを生成

        // LINE APIを使って音声メッセージとテキストメッセージを返信
        return client.replyMessage(event.replyToken, [
          {
            type: 'audio',
            originalContentUrl: pestionaudio, // 変数を直接渡す
            duration: 3000 // 音声の長さ（ミリ秒）
          },
          {
            type: 'text',
            text: 'なんのポケモンか当ててね☆'
          }
        ]);
      }
      else{
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: quizQuestion // クイズ問題を送信
        });
      }
    case 'ランキング':
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'ランキングページのリンクです\nhttps://liff.line.me/2006601390-A9BJvE9a'
      });
    case '画像設定':
      isSaved = true;
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '画像を送信してください'
      });
    case '音声再生':
      const audioname = ['porigon.wav', 'mikaruge.mp3', 'gaburiasu.mp3', 'aruseusu.mp3'];
      const randomsound = Math.floor(Math.random() * audioname.length);
      const pestionaudio = 'https://loveka-deploy.vercel.app/audio/' + audioname[randomsound];

      return client.replyMessage(event.replyToken, [
        {
          type: 'audio',
          originalContentUrl: pestionaudio, // 変数を直接渡す
          duration: 3000 // 音声の長さ（ミリ秒）
        },
        {
          type: 'text',
          text: 'なんのポケモンか当ててね☆'
        }
      ]);
  case '開催コンテスト':
    // 問題文を現在時間に近い順で取得（過ぎたものは除く）
    const nextQuizData = await quiz.where('day', '>=', admin.firestore.Timestamp.now()).orderBy('day').limit(1).get();

    if (!nextQuizData.empty) {
      const nextQuiz = nextQuizData.docs[0].data();
      quizQuestion = nextQuiz.question;
      quizDate = nextQuiz.day;

      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '次回コンテスト\nクイズ問題：' + quizQuestion + '\n終了日時：' + quizDate.toDate()
      });
    } else {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '次回コンテストはまだ設定されていません。'
      });
    }
  default:
    break;
  }

  // クイズ作成(要改善~Flexとかで値だけ入力できるようにする~)
  if (event.message.type === 'text' && event.message.text.startsWith('問題：')) {
    // メッセージから問題文と答えを抽出
    const messageParts = event.message.text.split('\n');
    const questionPart = messageParts.find(part => part.startsWith('問題：'));
    const answerPart = messageParts.find(part => part.startsWith('答え：'));
    const DayPart = messageParts.find(part => part.startsWith('終了日時：'));
  
    if (!questionPart || !answerPart || !DayPart) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '問題文の形式が正しくありません。\n【形式例】\n問題：〇〇\n答え：〇〇\n終了日時：20xx/01/01 00:00'
      });
    }
  
    // 問題文と答えを取得
    const question = questionPart.slice(3).trim();
    const answer = answerPart.slice(3).trim();
    const day = DayPart.slice(5).trim();

    // 終了日時をTimestamp型に変換
    const date = new Date(day);
    console.log(`date: ${date}`);
    if (isNaN(date.getTime())) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '終了日時の形式が正しくありません。\n【形式例】\n終了日時：20xx/01/01 00:00'
      });
    }
    const timestamp = admin.firestore.Timestamp.fromDate(date);

    if (!question || !answer || !day) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '問題文・答え・終了日時のいずれかが空欄です。'
      });
    }
  
    // Firestoreに登録
    try {
      await quiz.add({
        question: question,
        answer: answer,
        day: timestamp
      });  
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `クイズを登録しました！\n問題：「${question}」\n答え：「${answer}」\n終了日時：「${DayPart}」`
      });
    } catch (error) {
      console.error('Firestore登録エラー:', error);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'クイズの登録中にエラーが発生しました。もう一度お試しください。'
      });
    }
  }
  
// Firestoreのデータを表示するエンドポイント
app.get('/data', async (req, res) => {
  try {
    const snapshot = await collectionRef.get();
    const itemsname = [];
    snapshot.forEach((doc) => {
      itemsname.push(doc.data());
    });
    res.render('template', { itemsname: itemsname });
  } catch (error) {
    console.error('Error getting documents:', error);
    res.status(500).send('Error getting documents');
  }
  
});
app.get('/responses/:userId', async (req, res) => {
  const userId = req.params.userId;
  console.log('プル', userId);
  const userData = await getUserData(userId);
  if (userData) {
    res.render('ranking', { rankingData: userData }); // userData を rankingData として渡す
    console.log(`userdate表記`, userData);
  } else {
    res.status(404).send('User not found');
  }
});

  // Answerの判定
  if (event.message.type === 'text' && event.message.text === quizAnswer) {
    const RankingData = await getRankingData();
    console.log("確認",RankingData);
    let answered = false;
    RankingData.forEach((ranking)=> {
      if (ranking.userid === event.source.userId) {
        answered = true;
        
      }
      console.log('集会終了',event.source.userId);
      console.log('回答済み',ranking.id);
    });
    
    if (answered) {
      return client.replyMessage(event.replyToken, [{
        type: 'text',
        text: '回答済みです！'
      }]);
    } else {
      await Firestore_save(event);
      return client.replyMessage(event.replyToken, [{
        type: 'text',
        text: '正解です！'
      }, {
        type: 'text',
        text: 'ランキングページへのリンクです\nhttps://liff.line.me/2006601390-A9BJvE9a'
      }]);
    }
  } else if (event.message.type === 'text' && event.message.text !== quizAnswer) {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '不正解です！'
    });
  }

  switch (event.message.type) {
    case 'text':
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: event.message.text // テキストメッセージに対して同じテキストで返信
      });
    case 'sticker':
      return client.replyMessage(event.replyToken, {
            type: 'sticker',
            packageId: event.message.packageId,
            stickerId: event.message.stickerId // スタンプメッセージに対して同じスタンプで返信
          });
    case 'image':
      // 画像データを取得
      console.log(`replayToken: ${event.replyToken}`);
      console.log('画像データを取得します');
      const stream = await client.getMessageContent(event.message.id);
      let data = [];
      stream.on('data', (chunk) => {
        data.push(chunk);
      });
      
      stream.on('end', async () => {
        const buffer = Buffer.concat(data); // 受け取った画像データをバッファとしてまとめる
        // ここで画像データを処理する（例：ファイルに保存する、クラウドストレージにアップロードするなど）
        console.log(`画像データ: ${buffer}`);

        // Firestoreに画像データを保存
        if (isSaved) {
          isSaved = false;
          imagetest.add({
            buffer: buffer.toString('base64')
          });
          console.log('画像データをFirestoreに保存しました');
          return client.replyMessage(event.replyToken, {
            type: 'text',
            text: '画像を保存しました。'
          });
        }

        // Firestoreから保存済み画像を取得
        const snapshot = await imagetest.get();
        if (snapshot.empty) {
          console.log('Firestoreに保存された画像がありません。');
          return client.replyMessage(event.replyToken, {
            type: 'text',
            text: '比較対象の画像がありません。'
          });
        }
    
        let isMatch = false;
        let bestMatch = 0;


        for (const doc of snapshot.docs) {
          const storedBufferData = doc.data().buffer; // Firestoreから取得した画像データ
          if (!storedBufferData) {
            console.log('Firestoreに保存された画像データがありません。');
            continue;
          }
    
          const storedBuffer = Buffer.from(storedBufferData, 'base64'); // Firestoreに保存された画像をBuffer形式に変換
    
          // sharpを使って画像を読み込む
          const currentImage = await sharp(buffer).raw().toBuffer();
          const storedImage = await sharp(storedBuffer).raw().toBuffer();
    
          // 比較するために画像のピクセルデータを抽出
          const { width, height, channels } = await sharp(buffer).metadata();
          const pixelDifference = compareImages(currentImage, storedImage, width, height, channels);
    
          const similarity = 1 - (pixelDifference / (width * height * channels)); // 一致率を計算
    
          // 最良一致率を更新
          if (similarity > bestMatch) {
            bestMatch = similarity;
          }
        }
    
    
        // 一致率をLINEユーザーに通知
        if (bestMatch > 0.9) { // 90%以上の一致率
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: `画像が一致しました！ 一致率: ${(bestMatch * 100).toFixed(2)}%`
          });
        } else {
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: `画像が一致しませんでした。 一致率: ${(bestMatch * 100).toFixed(2)}%`
          });
        }
          
          console.log('画像データを取得しました');
        });
    
      // return client.replyMessage(event.replyToken, {
      //   type: 'text',
      //   text: '画像を受け取りました。' // 画像メッセージに対してテキストで返信
      // });
    
    default:
      return Promise.resolve(null); // その他のメッセージタイプは無視
  }
}

// 画像のピクセル単位での比較
function compareImages(image1, image2, width, height, channels) {
  let diff = 0;

  for (let i = 0; i < width * height * channels; i++) {
    if (image1[i] !== image2[i]) {
      diff++;
    }
  }

  return diff;
}
// Firestoreにデータを保存
async function Firestore_save(event)
{
  const profile = await client.getProfile(event.source.userId);
  const userName = profile.displayName;
  const timestamp = new Date().toISOString();
  const messageText = event.message.text || ''; // undefined のチェックを追加
  await collectionRef.add({
    userId: event.source.userId,
    userName: userName,
    message: messageText, // 修正
    timestamp: timestamp
  });
}