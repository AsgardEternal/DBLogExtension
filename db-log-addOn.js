// eslint-disable-file all
import Sequelize, { QueryTypes } from 'sequelize';

import DBLog from './db-log.js';
import path from "path";
import fs from "fs";
import { open } from "node:fs/promises"

const { DataTypes } = Sequelize;
const ServerState = {
  init: 0,
  seeding: 1,
  live: 2
};

export default class DBLogPlayerTime extends DBLog {
  static get description() {
    return 'replacement add-on to dblog for player join/seeding times';
  }

  static get defaultEnabled() {
    return false;
  }

  static get optionsSpecification() {
    return {
      ...DBLog.optionsSpecification,
      seedingThreshold: {
        required: false,
        description: 'seeding Threshold.',
        default: 50
      },
      whitelistfilepath: {
        required: false,
        description: 'path to a file to write out auto-wl',
        default: null
      },
      incseed: {
        required: false,
        description: 'rate of increase as a percentage to whitelist',
        default: 0
      },
      decseed: {
        required: false,
        description: 'rate of decrease as a percentage to whitelist',
        default: 0
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.seeding = ServerState.init;

    this.createModel(
      'PlayerTime',
      {
        id: {
          type: DataTypes.INTEGER,
          primaryKey: true,
          autoIncrement: true
        },
        startTime: {
          type: DataTypes.DATE
        },
        endTime: {
          type: DataTypes.DATE
        },
        serverState: {
          type: DataTypes.INTEGER
        },
        session: {
          type: DataTypes.INTEGER
        }
      },
      {
        charset: 'utf8mb4',
        collate: 'utf8mb4_unicode_ci'
      }
    );

    this.models.Server.hasMany(this.models.PlayerTime, {
      foreignKey: { name: 'server', allowNull: false },
      onDelete: 'CASCADE'
    });

    this.models.SteamUser.hasMany(this.models.PlayerTime, {
      foreignKey: { name: 'player' },
      onDelete: 'CASCADE'
    });

    this.onPlayerConnected = this.onPlayerConnected.bind(this);
    this.onPlayerDisconnected = this.onPlayerDisconnected.bind(this);
  }

  async prepareToMount() {
    await super.prepareToMount();
    await this.models.PlayerTime.sync();
  }

  async mount() {
    console.log('Mounting db-log');
    if (this.server.currentLayer) {
      if (this.server.currentLayer.gamemode === 'Seed') {
        console.log('starting to seeding');
        this.seeding = ServerState.seeding;
      } else {
        console.log('starting to Live');
        this.seeding = ServerState.live;
      }
    } else {
      if (this.server.currentLayerRcon.layer.includes('Seed')) {
        console.log('starting to seeding');
        this.seeding = ServerState.seeding;
      } else {
        console.log('starting to Live');
        this.seeding = ServerState.live;
      }
    }
    await super.mount();
    console.log('finished mounting db-log');
    this.server.on('PLAYER_CONNECTED', this.onPlayerConnected);
    this.server.on('PLAYER_DISCONNECTED', this.onPlayerDisconnected);
    console.log('finished mounting db-log-addOn');
  }

  async repairDB() {
    console.log('starting DB repair');
    await super.repairDB();

    console.log('starting DB repair for addOn');

    const lastTickTime = await this.models.TickRate.findOne({
      where: { server: this.options.overrideServerID || this.server.id },
      order: [['id', 'DESC']],
      logging: console.log
    });
    console.log('last tick found:', lastTickTime);

    if(!lastTickTime) return;
    const lastServerDate = lastTickTime.time;
    const lastServerTime =
      lastServerDate.getFullYear() +
      '-' +
      (lastServerDate.getMonth() + 1) +
      '-' +
      lastServerDate.getDate() +
      ' ' +
      lastServerDate.getHours() +
      ':' +
      lastServerDate.getMinutes() +
      ':' +
      lastServerDate.getSeconds();
    console.log('last time found:', lastServerTime);

    const playerOnlineID = [];
    playerOnlineID.push(0);
    for (const player of this.server.players) {
      playerOnlineID.push(player.steamID);
    }
    console.log('players online:', playerOnlineID);

    const { notIn, is } = Sequelize.Op;
    const updateVals = { endTime: lastServerTime };
    const whereStuff = {
      endTime: { [is]: null },
      server: this.options.overrideServerID || this.server.id,
      player: { [notIn]: playerOnlineID }
    };
    console.log(updateVals);
    console.log(whereStuff);

    const rowUpdate = await this.models.PlayerTime.update(updateVals, {
      where: whereStuff,
      logging: console.log
    });

    console.log('updated playerTimes row count: %i', rowUpdate[0]);
    console.log('finish DB repair');
  }

  async unmount() {
    this.models.PlayerTime.update(
      { leaveTime: 0 },
      { where: { leaveTime: null, server: this.options.overrideServerID || this.server.id } }
    );
    await super.unmount();
    this.server.removeEventListener('PLAYER_CONNECTED', this.onPlayerConnected);
    this.server.removeEventListener('PLAYER_DISCONNECTED', this.onPlayerDisconnected);
  }

  async updateCurrentTimeState(date, oldState, newState) {
    if (oldState === newState) return;
    this.seeding = newState;
    const timeNow =
      date.getFullYear() +
      '-' +
      (date.getMonth() + 1) +
      '-' +
      date.getDate() +
      ' ' +
      date.getHours() +
      ':' +
      date.getMinutes() +
      ':' +
      date.getSeconds();
    console.log(timeNow);
    const curPlayer = await this.models.PlayerTime.findAll({
      where: {
        endTime: null,
        serverState: oldState,
        server: this.options.overrideServerID || this.server.id
      }
    });
    console.log(curPlayer);
    const curplayerarr = [];
    for (const oneplayer of curPlayer) {
      console.log(oneplayer);
      curplayerarr.push({
        startTime: timeNow,
        endTime: null,
        serverState: newState,
        session: oneplayer.session,
        server: oneplayer.server,
        player: oneplayer.player
      });
    }
    console.log(curplayerarr);
    await this.models.PlayerTime.update(
      { endTime: timeNow },
      {
        where: {
          endTime: null,
          serverState: oldState,
          server: this.options.overrideServerID || this.server.id
        }
      }
    );
    await this.models.PlayerTime.bulkCreate(curplayerarr, {
      fields: ['startTime', 'endTime', 'serverState', 'session', 'server', 'player']
    });
    await this.updateAutoWL();
  }

  async onUpdatedA2SInformation(info) {
    await super.onUpdatedA2SInformation(info);

    //         const curDateTime = new Date();
    //         if ((this.seeding !== ServerState.live) && (info.a2sPlayerCount >= this.options.seedingThreshold)) {
    //             console.log('switching to Live');
    //             await this.updateCurrentTimeState(curDateTime, this.seeding, ServerState.live);
    //         } else if (this.seeding === false && (info.a2sPlayerCount - 20) < this.options.seedingThreshold) {
    //             console.log('switching to seeding');
    //             await this.updateCurrentTimeState(curDateTime, this.seeding, ServerState.seeding);
    //         }
  }

  async updateAutoWL() {
    if(!this.options.whitelistfilepath) return;
    // eslint-disable-next-line no-unused-vars
    const seedTimes = await this.models.query(
      'select lastName as playername, discordID, steamID, ' +
        'sum(time_to_sec(timediff(ifnull(endTime,now()), startTime))/3600) as seedTime ' +
        'from DBLog_PlayerTimes join DBLog_SteamUsers DLSU on DBLog_PlayerTimes.player = DLSU.steamID ' +
        'where startTime between (now() - INTERVAL 1 WEEK) and now() and server != 3 and serverState=1 ' +
        'group by player ' +
        'order by seedTime desc',
      { type: QueryTypes.SELECT }
    );

    const topTime = seedTimes[0].seedTime;
    const seedid = [];
    for(const seeder of seedTimes){
      if(((this.options.incseed*seeder.seedTime) - (this.options.decseed*(topTime-seeder.seedTime))) > 100) seedid.push(seeder);
    }

    const lcladminpath = path.resolve(__dirname, "../../../", this.options.whitelistfilepath);
    if(!fs.existsSync(lcladminpath)) {
      this.verbose(1, "WARNING: auto whitelist admins file not found");
      return;
    }

    const adminfile = await open(lcladminpath, 'rw');
    await adminfile.write(`Group=server-${this.server.options.id}-autowl:reserve\n`);
    for(const seeding of seedid){
      await adminfile.write(`Admin=${seeding.steamID}:server-${this.server.options.id}-autowl //name:${seeding.playername}, discord ID: ${seeding.discordID}\n`);
    }
  }

  async onNewGame(info) {
    await super.onNewGame(info);

    console.log(info);
    const curDateTime = info.time;
    if (info.layer) {
      if (info.layer.gamemode === 'Seed') {
        console.log('switching to seeding');
        await this.updateCurrentTimeState(curDateTime, this.seeding, ServerState.seeding);
      } else {
        console.log('switching to Live');
        await this.updateCurrentTimeState(curDateTime, this.seeding, ServerState.live);
      }
    } else {
      if (info.layerClassname.includes('Seed')) {
        console.log('switching to seeding');
        await this.updateCurrentTimeState(curDateTime, this.seeding, ServerState.seeding);
      } else {
        console.log('switching to Live');
        await this.updateCurrentTimeState(curDateTime, this.seeding, ServerState.live);
      }
    }

    // eslint-disable-next-line no-empty
    if (this.seeding !== ServerState.seeding) {
    }
  }

  async onPlayerConnected(info) {
    console.log(info);
    if (info.player) {
      await this.models.SteamUser.upsert({
        steamID: info.player.steamID,
        lastName: info.player.name
      });
      await this.models.PlayerTime.create({
        server: this.options.overrideServerID || this.server.id,
        player: info.steamID,
        startTime: info.time,
        serverState: this.seeding
      });
      console.log('player connect complete');
    } else console.log('player is null');
  }

  async onPlayerDisconnected(info) {
    // eslint-disable-next-line promise/param-names
    await new Promise((r) => setTimeout(r, 500));
    console.log(info);
    if (info.player) {
      await this.models.SteamUser.upsert({
        steamID: info.player.steamID,
        lastName: info.player.name
      });
    }
    const rowAffect = await this.models.PlayerTime.update(
      { endTime: info.time },
      {
        where: {
          player: info.steamID,
          endTime: null,
          server: this.options.overrideServerID || this.server.id
        }
      }
    );
    console.log('player disconnect rows update: %i', rowAffect[0]);
  }
}
