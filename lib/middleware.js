const debug = require('debug')('jambonz:sbc-outbound');
const parseUri = require('drachtio-srf').parseUri;
const Registrar = require('@jambonz/mw-registrar');
const {selectHostPort, makeCallCountKey} = require('./utils');
const FS_UUID_SET_NAME =  'fsUUIDs';

module.exports = (srf, logger, opts) => {
  const {incrKey, decrKey, isMemberOfSet} = srf.locals.realtimeDbHelpers;
  const {stats} = srf.locals;
  const registrar = new Registrar(opts);
  const {
    lookupAccountCapacitiesBySid,
    lookupAccountBySid
  }  = srf.locals.dbHelpers;

  const initLocals = async(req, res, next) => {
    req.locals = req.locals || {};
    const callId = req.get('Call-ID');
    req.locals.account_sid = req.get('X-Account-Sid');
    req.locals.logger = logger.child({callId, account_sid: req.locals.account_sid});

    if (!req.locals.account_sid) {
      logger.info('missing X-Account-Sid on outbound call');
      res.send(403, {
        headers: {
          'X-Reason': 'missing X-Account-Sid'
        }
      });
      return req.srf.endSession(req);
    }

    /* must come from a valid FS */
    if (!req.has('X-Jambonz-Routing')) {
      logger.info({msg: req.msg}, 'missing X-Jambonz-Routing header');
      res.send(403, {
        headers: {
          'X-Reason': 'missing required jambonz headers'
        }
      });
      return req.srf.endSession(req);
    }
    if (process.env.K8S) {
      /* for K8S we do not use JAMBONES_CIDR so we must validate the sender by uuid FS creates */
      const fsUUID = req.get('X-Jambonz-FS-UUID');
      try {
        const exists = await isMemberOfSet(FS_UUID_SET_NAME, fsUUID);
        if (!exists || !fsUUID) {
          res.send(403, {
            headers: {
              'X-Reason': `missing or invalid FS-UUID ${fsUUID}`
            }
          });
          return req.srf.endSession(req);
        }
      } catch (err) {
        res.send(500);
        return req.srf.endSession(req);
      }
    }


    stats.increment('sbc.invites', ['direction:outbound']);

    req.on('cancel', () => {
      req.locals.logger.info({callId}, 'caller hungup before connecting');
      req.canceled = true;
      const tags = ['canceled:yes', 'sipStatus:487'];
      if (req.locals.originator) tags.push(`originator:${req.locals.originator}`);
      stats.increment('sbc.origination', tags);
    });

    try {
      req.locals.account = await lookupAccountBySid(req.locals.account_sid);
    } catch (err) {
      req.locals.logger.error({err}, `Error looking up account sid ${req.locals.account_sid}`);
      res.send(500);
      return req.srf.endSession(req);
    }
    next();
  };

  const checkLimits = async(req, res, next) => {
    const {logger, account_sid} = req.locals;
    const {writeAlerts, AlertType} = req.srf.locals;

    const key = makeCallCountKey(account_sid);
    try {
      /* increment the call count */
      const calls = await incrKey(key);
      debug(`checkLimits: call count is now ${calls}`);

      /* decrement count if INVITE is later rejected */
      res.once('end', ({status}) => {
        if (status > 200) {
          debug('checkLimits: decrementing call count due to rejection');
          decrKey(key)
            .then((count) => {
              logger.debug({key}, `after rejection there are ${count} active calls for this account`);
              debug({key}, `after rejection there are ${count} active calls for this account`);
              return;
            })
            .catch((err) => logger.error({err}, 'checkLimits: decrKey err'));
          const tags = ['accepted:no', `sipStatus:${status}`];
          stats.increment('sbc.originations', tags);
        }
        else {
          const tags = ['accepted:yes', 'sipStatus:200'];
          stats.increment('sbc.originations', tags);
        }
      });

      /* compare to account's limit, though avoid db hit when call count is low */
      const minLimit = process.env.MIN_CALL_LIMIT ?
        parseInt(process.env.MIN_CALL_LIMIT) :
        0;
      if (calls <= minLimit) return next();

      const capacities = await lookupAccountCapacitiesBySid(account_sid);
      const limit = capacities.find((c) => c.category == 'voice_call_session');
      if (!limit) {
        logger.debug('checkLimits: no call limits specified');
        return next();
      }
      const limit_sessions = limit.quantity;

      if (calls > limit_sessions) {
        debug(`checkLimits: limits exceeded: call count ${calls}, limit ${limit_sessions}`);
        logger.info({calls, limit_sessions}, 'checkLimits: limits exceeded');
        writeAlerts({
          alert_type: AlertType.CALL_LIMIT,
          account_sid,
          count: limit_sessions
        }).catch((err) => logger.info({err}, 'checkLimits: error writing alert'));

        res.send(503, 'Maximum Calls In Progress');
        return req.srf.endSession(req);
      }
      next();
    } catch (err) {
      logger.error({err}, 'error checking limits error for inbound call');
      res.send(500);
    }
  };

  const route = async(req, res, next) => {
    const logger = req.locals.logger;
    const {lookupAccountBySipRealm} = req.srf.locals.dbHelpers;
    logger.info(`received outbound INVITE to ${req.uri} from server at ${req.server.hostport}`);
    const uri = parseUri(req.uri);
    const desiredRouting = req.get('X-Jambonz-Routing');

    if (!uri || !uri.user || !uri.host) {
      logger.info({uri: req.uri}, 'invalid request-uri on outbound call, rejecting');
      res.send(400, {
        headers: {
          'X-Reason': 'invalid request-uri'
        }
      });
      return req.srf.endSession(req);
    }
    debug(`received outbound INVITE to ${req.calledNumber} from server at ${req.server.hostport}`);

    if ('teams' === desiredRouting) {
      logger.debug('This is a call to ms teams');
      req.locals.target = 'teams';
    }
    else if ('user' === desiredRouting) {
      const aor = `${uri.user}@${uri.host}`;
      const reg = await registrar.query(aor);
      if (reg) {
        // user is registered..find out which sbc is handling it
        // us => we can put the call through
        // other sbc => proxy the call there
        logger.info({details: reg}, `sending call to registered user ${aor}`);
        if (req.server.hostport !== reg.sbcAddress) {
          /* redirect to the correct SBC where this user is connected */
          const proxyAddress = selectHostPort(reg.sbcAddress, 'tcp');
          const redirectUri =  `<sip:${proxyAddress[1]}>`;
          logger.info(`redirecting call to SBC at ${redirectUri}`);
          return res.send(302, {headers: {Contact: redirectUri}});
        }
        req.locals.registration = reg;
        req.locals.target = 'user';
      }
      else {
        const account = await lookupAccountBySipRealm(uri.host);
        if (account) {
          logger.info({host: uri.host, account}, `returning 404 to unregistered user in valid domain: ${req.uri}`);
        }
        else {
          logger.info({host: uri.host, account}, `returning 404 to user in invalid domain: ${req.uri}`);
        }
        res.send(404);
        return req.srf.endSession(req);
      }
    }
    else if ('sip' === desiredRouting) {
      // call that needs to be forwarded to a sip endpoint
      logger.info(`forwarding call to sip endpoint ${req.uri}`);
      req.locals.target = 'forward';
    }
    else if ('phone' === desiredRouting) {
      debug('sending call to LCR');
      req.locals.target = 'lcr';
    }
    next();
  };

  return {
    initLocals,
    checkLimits,
    route
  };
};
