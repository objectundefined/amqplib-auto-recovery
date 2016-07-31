'use strict';

var backoff = require('backoff');

/**
 * Creates a new instance of AMQP client with automatic connection recovery
 * enabled. Note that `amqp.connect(...)` callback will be executed each time
 * (re)connection is attempted.
 *
 * @param {object} amqp `require('amqplib/callback_api')` instance
 * @param {object} [o] config options
 * @param {function(err: Error)} [o.onError] called in case of an error
 * @param {function(err: Error)} [o.isErrorUnrecoverable] used to determine
 * whether reconnection should take place
 * @param {function(call: backoff.FunctionCall, backoff)} [o.configureBackoff] 
 * a way to configure a custom backoff strategy
 *  
 * @returns {object} decorated instance of amqp client (original instance is not
 * modified)
 */
module.exports = function withAutoRecovery(amqp, opts) {
  var o = opts || {};
  var onError = o.onError || function () {};
  var isErrorUnrecoverable = o.isErrorUnrecoverable || function () {
    return false;
  };
  var lib = Object.create(amqp, {
    connect: {
      value: function connect(url, connectCallback) {
        var activeConnection = null;
        var spec = backoff.call(function (cb) {
          amqp.connect(url, function (err, con) {
            if (err) {
              connectCallback(err);
              cb(!isErrorUnrecoverable(err) ? err : null);
              return;
            }
            var lastError = void 0;
            activeConnection = con;
            con.on('error', function (err) {
              lastError = err;
              onError(new Error('Connection failed(' + err.message + ')'));
            });
            var connectionClosed = false;
            con.on('close', function () {
              connectionClosed = true;
              if (activeConnection) {
                // we were able to establish connection but something went
                // wrong later on -> reconnect
                if (!lastError || !isErrorUnrecoverable(lastError)) {
                  process.nextTick(connect, url, connectCallback);
                }
              }
              // the only case when activeConnection might be null is if
              // connection was explicitly terminated by the client through
              // (decorated) connection.close()
              // in which case we should do nothing
            });
            var closeConnection = function closeConnection() {
              try {
                con.close();
              } catch (e) {
                // https://github.com/squaremo/amqp.node/blob/v0.4.2/lib/connection.js#L364
                if (e.name !== 'IllegalOperationError') {
                  throw e;
                }
              }
            };
            var channelCallback = function channelCallback(cb, err, ch) {
              if (err) {
                // todo: check for channelMax
                lastError = err;
                onError(new Error('Failed to create a channel(' + err.message + ')'));
                cb(err);
                closeConnection();
                return;
              }
              ch.on('error', function (err) {
                lastError = err;
                onError(new Error('Channel failed($ {\n                  err.message\n                })'));
              });
              var channelClosedByClient = void 0;
              var channelClosed = false;
              ch.on('close', function () {
                channelClosed = true;
                // do not close the connection if channel was deliberately
                // closed by the client
                channelClosedByClient || closeConnection();
              });
              cb(null, new Proxy(ch, {
                get: function get(target, name) {
                  switch (name) {
                    case 'close':
                      return function close(cb) {
                        channelClosedByClient = true;
                        target.close(cb);
                      };
                    case 'closed':
                      return channelClosed;
                    default:
                      return target[name];
                  }
                }
              }));
            };
            connectCallback(null, Object.create(con, {
              createChannel: {
                value: function createChannel(cb) {
                  con.createChannel(channelCallback.bind(null, cb));
                }
              },
              createConfirmChannel: {
                value: function createConfirmChannel(cb) {
                  con.createConfirmChannel(channelCallback.bind(null, cb));
                }
              },
              close: {
                value: function close(cb) {
                  activeConnection = null;
                  con.close(cb);
                }
              },
              // not part of amqplib
              closeAndReconnect: {
                value: function closeAndReconnect(cb) {
                  con.close(cb);
                }
              },
              closed: {
                get: function get() {
                  return connectionClosed;
                }
              }
            }));
            cb();
          });
        }, function () {});
        if (o.configureBackoff) {
          o.configureBackoff(spec, backoff);
        } else {
          spec.setStrategy(new backoff.ExponentialStrategy({
            randomisationFactor: 0.1,
            initialDelay: 1000,
            maxDelay: 30000
          }));
        }
        spec.start();
      }
    }
  });
};
