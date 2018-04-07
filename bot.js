'use strict';

const puppeteer      = require('puppeteer');
const CDP            = require('chrome-remote-interface');
const fs             = require('fs');
const xml            = require("xml-parse");
const cv             = require('opencv');
const cheerio        = require('cheerio');
const crypto         = require('crypto');
const EventEmitter   = require('events');

var exposedPage;
var exposedMain;
var exposedChat;
var exposedArea;
var exposedLog;
var hunting = false;
var farming = false;
var farmingIn = false;
var fighting = false;
var myStrike = false;
var striking = false;
var intercepting = false;

const time = Date.now().toString()
const logPath = `./logs/botLog_${time}.txt`;
const chatLogPath = `./chatLogs/botLog_${time}.txt`

class Bot extends EventEmitter {
  constructor(browser = {}, viewport = { width: 1440, height: 794 }, browserSettings = {
      headless: false,
      args: ['--disable-dev-shm-usage', '--start-maximized', 'http://oldwar.net', '--disable-infobars', '--disable-session-crashed-bubble'],
      executablePath: './chrome-win32/chrome.exe',
      userDataDir: './userdata',
    }
  ) {
    super();

    this.browser = browser;
    this.browserSettings = browserSettings;
    this.page = null;
    this.chat = null;
    this.cdpPage = null;
    this.Network = null;
    this.viewport = viewport;

    this.main = null;
    this.area = null;
    this.chat = null;
    this.log  = null;

    let login = process.env.BOT_LOGIN || null;
    let password = process.env.BOT_PASSWORD || null;
    this.credentials = { login, password };
    this.level = null;
    this.combo = null;
    this.strikes = [
      {x: 356, y: 297, w: 24, h: 47}, // block
      {x: 422, y: 253, w: 51, h: 35}, // up
      {x: 459, y: 301, w: 31, h: 37}, // center
      {x: 422, y: 359, w: 50, h: 30} // down
    ]
  }

  async init() {
    writeLog('initializing...');
    if (this.browser !== null) {
      this.browser = await this.launchBrowser(this.browserSettings);
      writeLog('browser launched')
    }
      
    const client = await this.connectBrowser();
    writeLog('connected')

    this.cdpPage = client.Page;
    this.Network = client.Network;
    this.Network.enable();
    this.cdpPage.enable();

    const pages = await this.browser.pages();
    this.page = exposedPage = pages[0];
    
    this.page.setViewport(this.viewport);
    await this.page.waitForNavigation({waitUntil: 'load' });
  }

  async start() {
    writeLog('starting bot...');
    this.active = true;

    await this.init();
    writeLog('initialized');

    await this.page.exposeFunction('startHunt', this.startHunt);
    await this.page.exposeFunction('startFarm', this.startFarm);
    await this.page.exposeFunction('stopHunt', this.stopHunt);
    await this.page.exposeFunction('handleLog', this.handleFightLog);
    await this.page.exposeFunction('makeScreenshot', this.makeScreenshot);
    await this.page.exposeFunction('bot', this);

    await this.authenticate();
    writeLog('authenticated');
    
    this.level = await this.getLvl();

    writeLog('initializing controls...');
    this.page.on('load', () => {
      this.onloadHandler();
    });
    writeLog('controls ready');

    await this.getFrames();

    this.page.on('response', async (response) => {
      const url = await response.url();

      if ((hunting || farming) && url.endsWith('hunt_conf.php')) {
        let xmlData = await response.text();
        let body = xml.parse(xmlData)[1].childNodes;

        body.forEach((tag) => {
          if (tag.tagName == 'bots' && hunting) {
            this.huntingLoop(tag.childNodes);
          }

          if (tag.tagName == 'farm' && farming && !farmingIn) {
            this.farmingLoop(tag.childNodes);
          }
        })
      }

      if (farming && farmingIn && url.indexOf('hunt_conf.php') && url.endsWith('end=1')) {
        let xmlData = await response.text();
        let status = xml.parse(xmlData)[1].attributes.status;
        console.log(xmlData);
        if (status) {
          farmingIn = false;
          await exposedArea.evaluate(() => location.href = 'http://oldwar.net/hunt.php');
        }
      }

      if (url.endsWith('cht_data.php')) {
        let req = await response.request();
        let postData = await req.postData();
        
        if (postData.indexOf('text=1&user=0') > -1) {
          let resText = await response.text();
          let anchor = resText.indexOf('chatTextHtml');
          let html;

          if (anchor > -1) {
            let firstIndex = resText.indexOf("'<", anchor);
            let lastIndex  = resText.indexOf(">'", firstIndex + 1);

            html = resText.slice(firstIndex + 1, lastIndex + 1);
          }

          if (html.indexOf('chatUserHtml') === -1 && html !== '') {
            const $ = cheerio.load(html);
            let text = $('div').text();

            writeLog(text, 'chat');

            // if (fighting && !hunting && text.indexOf('Окончен бой') > -1) {
            //   fighting = false;
            //   hunting = true;
            //   await this.startHunt();
            // }
          }
        }
      }
    });

    this.screencastLoop();
  }

  

  async launchBrowser(options) {
    writeLog('launching browser...');
    return await puppeteer.launch(options);
  }

  async connectBrowser() {
    writeLog('connecting...');
    let endpoint = await this.browser.wsEndpoint();
    endpoint = endpoint.replace('/', ':');
    endpoint = endpoint.split(':')[3];
    endpoint = endpoint.split('/')[0];

    return await CDP({ port: endpoint })
  }

  async authenticate() {
    if (this.credentials.login !== null && this.credentials.password !== null) {
      writeLog('authenticating...');
      await this.page.$eval('#userEmail', (el) => el.value = '');
      await this.page.$eval('#userPassword', (el) => el.value = '')

      await this.page.type('#userEmail', this.credentials.login);
      await this.page.type('#userPassword', this.credentials.password);

      await this.page.click('input[type="image"]');

      return;
    }

    writeLog('waiting for authentication...');
    
    return await this.page.waitForNavigation({ waitUntil: 'domcontentloaded' });
  }

  async onloadHandler() {
    await this.getFrames();
    await this.createControls();
    await this.setupLogHandler();
  }

  async getFrames() {
    let frames = await this.page.frames();

    for (let frame of frames) {
      let name = await frame.name();

      if (name == 'main_frame' && !this.main) {
        this.main = exposedMain = frame;
      }

      if (name == 'main' && !this.area) {
        this.area = exposedArea = frame;
      }

      if (name == 'chat' && !this.chat) {
        this.chat = exposedChat = frame;
      }

      if (name == 'chat_log' && !this.fightLog) {
        this.log = exposedLog = frame;
      }
    }
  }

  async createControls() {
    await exposedPage.$eval('body', (body) => {
      var container = document.createElement('div');
      container.style.position = 'fixed';
      container.style.top = '5px';
      container.style.left = '5px';
      container.style.padding = '10px';
      container.style.background = 'white';
      container.style.border = '2px solid black';
      container.style.borderRadius = '5px';

      var title = document.createElement('h4');
      title.innerText = 'Панель управления';
      title.style.marginTop = '0';
      title.style.marginBottom = '10px';
      container.appendChild(title);

      var button1 = document.createElement('button');
      button1.innerText = 'Начать охоту';
      button1.style.display = 'block';
      button1.style.width = '100%';
      button1.onclick = window.startHunt;
      container.appendChild(button1);

      var button4 = document.createElement('button');
      button4.innerText = 'Начать добычу';
      button4.style.display = 'block';
      button4.style.width = '100%';
      button4.onclick = window.startFarm;
      container.appendChild(button4);

      var button2 = document.createElement('button');
      button2.innerText = 'Закончить охоту';
      button2.style.display = 'block';
      button2.style.width = '100%';
      button2.onclick = window.stopHunt;
      container.appendChild(button2);

      var button3 = document.createElement('button');
      button3.innerText = 'Сделать скриншот';
      button3.style.display = 'block';
      button3.style.width = '100%';
      button3.onclick = window.makeScreenshot;
      container.appendChild(button3);

      body.appendChild(container);
    });
  }

  async setupLogHandler() {
    await this.log.$eval('#content', (el) => {
      var observer = new MutationObserver(function(mutations) {
        mutations.forEach((mutation) => {
          
          if (mutation.addedNodes[0].classList && mutation.addedNodes[0].classList.contains('fightlog_light')) {
            console.log(mutation.addedNodes[0].lastElementChild);
            window.handleLog(mutation.addedNodes[0].lastElementChild.innerText);
          }

          if (mutation.addedNodes[0].classList && mutation.addedNodes[0].classList.contains('fightlog_dark')) {
            let elem = mutation.addedNodes[0];
            let win = elem.querySelector('.win') ? true : false;
            if (win) {
              window.handleLog(undefined, win);
            }
            
          }
          
        })
      });

      var config = { childList: true, subtree: true };
 
      observer.observe(el, config);
    });
  }

  async screencastLoop() {
    writeLog('starting screencast...');
    await this.cdpPage.startScreencast({format: 'jpeg', quality: 60, everyNthFrame: 1});
    writeLog('screencast started');

    while(true) {
      const {data, metadata, sessionId} = await this.cdpPage.screencastFrame();

      if (fighting && !myStrike && !striking) {
        let output = await this.matchImg('./fight.jpg', Buffer.from(data, 'base64'));

        if (output[1] > 380 && output[1] < 450 && output[2] > 290 && output[2] < 350) {
          myStrike = true;
        } else {
          myStrike = false;
        }
      }

      await this.cdpPage.screencastFrameAck({sessionId: sessionId});
    }
  }

  matchImg(templatePath, frame) {
    return new Promise(function(resolve, reject) {
      cv.readImage(frame, (err, img) => {
        if (err) reject(err);

        try {
          let output = img.matchTemplate(templatePath, 3);

          var matches = output[0].templateMatches(0, 1, 1, false);
          resolve(output);
        } catch(e) {
          reject(e);
        }
      })
    })
  }

  async getLvl() {
    await this.page.waitForSelector('iframe[name="main_frame"]');

    let frames = await this.page.frames();
    let frame = frames[1];
    await frame.waitForSelector('[usemap] + table embed');
    let lvl = await frame.$eval('[usemap] + table embed', (el) => el.getAttribute('flashvars'));
    let index = lvl.indexOf('lvl=') + 4;
    return lvl[index];
  }

  async startHunt() {
    writeLog('start hunting...');
    hunting = true;
    await exposedArea.evaluate(() => location.href = 'http://oldwar.net/hunt.php');
    
    writeLog('hunting started');
  }

  async startFarm() {
    writeLog('start farming...');
    farming = true;
    await exposedArea.evaluate(() => location.href = 'http://oldwar.net/hunt.php');
    
    writeLog('farming started');
  }

  async huntingLoop(mobsArr) {
    for (let mob of mobsArr) {
      if (mob.tagName && mob.tagName === 'bot') {
        let attr = mob.attributes;
        let id = attr.id;
        let name = attr.name;
        let level = attr.level;
        let inBattle = attr.fight_id;

        if (inBattle == 0 && (name.indexOf('вожак') > -1)) { // l || level == (this.level - 1)
          writeLog(`attacking ${name}[${level}]`);
          let fightUrl = `http://oldwar.net/action_run.php?code=ATTACK_BOT&url_success=fight.php?${Math.floor(Math.random()*1000000000)}&url_error=hunt.php&bot_id=${id}`;
          let entryUrl = 'http://oldwar.net/entry_point.php?object=common&action=action&json_mode_on=1';
          await exposedArea.evaluate((url1, url2) => {
            location.href = url1;
            fetch(url2, {
              method: 'POST',
              object: 'common',
              action: 'action',
              json_mode_on: 1
            })
          }, fightUrl, entryUrl);
          
          hunting = false;
          this.startFight();
          break;
        }
      }
    };
  }

  async farmingLoop(resArr) {
    for (let res of resArr) {
      if (res.tagName && res.tagName == 'item') {
        let attr = res.attributes;
        let id = attr.num;
        let name = attr.name;
        let skill = attr.skill;
        let prof = attr.prof;
        let isfarming = attr.farming;
        let x = attr.x;
        let y = attr.y;

        let randX = Math.random() * ((x + 5) - (x - 5)) + (x - 5);
        let randY = Math.random() * ((y + 5) - (y - 5)) + (y - 5);
        let xy = Math.floor(randX + randY);

        let secret = '41775e02da98ddb63c980dee';

        let stringToHash = xy.toString() + id + secret;

        let sig = crypto.createHash('md5').update(stringToHash).digest("hex");

        if (prof == 1 && (name == 'Омела') && isfarming == 0) { 
          writeLog(`farming ${name}`);
          let farmUrl = `http://oldwar.net/hunt_conf.php?mode=farm&action=chek&xy=${xy}2&sig=${sig}&num=${id}&t=1`;
          await exposedArea.evaluate((url1) => {
            location.href = url1;
          }, farmUrl);

          setTimeout(async () => {
            let checkUrl = `http://oldwar.net/hunt_conf.php?mode=farm&action=chek&xy=${xy}&end=1`;
            await exposedArea.evaluate((url1) => {
              location.href = url1;
            }, checkUrl);
          }, 17000)

          farmingIn = true;
          break;
        }
      }
    }
  }

  async stopHunt() {
    writeLog('stopping hunting...');
    // await exposedArea.evaluate(() => location.href = 'http://oldwar.net/area.php');

    fighting = false;
    hunting = false;
    writeLog('hunting stopped');
  }

  async startFight() {
    writeLog('start fighting...')
    this.combo = await this.getCombo();
    writeLog('combo ready')

    fighting = true;
    myStrike = false;
    this.fightingLoop();
  }

  async getCombo() {
    writeLog('getting combo...')
    await exposedArea.waitForSelector('#combo_user_table_show tr:nth-child(3) span');

    return await exposedArea.$$eval('#combo_user_table_show tr:nth-child(3) span', (strikes) => {
      let combo = [];

      strikes.forEach((strike) => {
        combo.push(strike.getAttribute('cmb'));
      })

      return combo;
    })
  }

  *comboLoop() {
    let comboLength = this.combo.length;

    for (let i = 0; i < comboLength; i++) {
      yield this.combo[i];
    }
  }

  fightingLoop() {
    let comboLoop = this.comboLoop();
    let combo;
    let self = this;
    
    (async function fight() {
      if (fighting) {
        if (!myStrike) {
          writeLog('waiting for enemy...');
        } else {
          if (!striking) {
            writeLog('my turn');
            striking = true;

            combo = comboLoop.next();

            if (combo.done) {
              comboLoop = self.comboLoop();
              combo = comboLoop.next();
            }

            let strike = combo.value;
            self.makeStrike(strike);

            let backupStrike = setInterval(() => {
              self.makeStrike(strike);
            }, 1500)

            self.once('logUpdate', () => {
              clearInterval(backupStrike);
              striking = false;
            });
          }
         
        }

        setTimeout(fight, 200);
      }
    })();
  }

  async handleFightLog(data, win) {
    if (win) {
      fighting = false;
      hunting = true;
      await this.startHunt();
      writeLog('fight ended');
      return;
    }

    this.bot.emit('logUpdate', data);
  }

  async makeStrike(strike) {
    let cords = this.strikes[strike];

    switch (strike) {
      case '1':
        writeLog('attack head!');
        break;
      case '2':
        writeLog('attack body!');
        break;
      case '3':
        writeLog('attack legs!');
    }

    let point = {
      x: Math.floor(Math.random() * ((+cords.x + cords.w) - cords.x)) + cords.x,
      y: Math.floor(Math.random() * ((+cords.y + cords.h) - cords.y)) + cords.y
    }

    await this.page.mouse.click(point.x, point.y);

    myStrike = false;
    return;
  }

  // async checkWin() {
  //   TODO
  // }

  async makeScreenshot() {
    return await exposedPage.screenshot({ path: `./img/${Date.now().toString()}.png`, fullpage: true });
  }

  
}

function writeLog(text, type = 'log') {
  let path;

  if (type == 'log') {
    console.log(text);
    path = logPath;
  } else {
    path = chatLogPath;
  }

  fs.appendFile(path, `${text}\r\n`, (err) => {
    if (err) throw err;
  })
}

module.exports = { Bot };
