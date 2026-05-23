#!/usr/bin/env node
import{createRequire as __cmxCR}from'node:module';const require=__cmxCR(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/ws/lib/constants.js
var require_constants = __commonJS({
  "node_modules/ws/lib/constants.js"(exports, module) {
    "use strict";
    var BINARY_TYPES = ["nodebuffer", "arraybuffer", "fragments"];
    var hasBlob = typeof Blob !== "undefined";
    if (hasBlob) BINARY_TYPES.push("blob");
    module.exports = {
      BINARY_TYPES,
      CLOSE_TIMEOUT: 3e4,
      EMPTY_BUFFER: Buffer.alloc(0),
      GUID: "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      hasBlob,
      kForOnEventAttribute: Symbol("kIsForOnEventAttribute"),
      kListener: Symbol("kListener"),
      kStatusCode: Symbol("status-code"),
      kWebSocket: Symbol("websocket"),
      NOOP: () => {
      }
    };
  }
});

// node_modules/ws/lib/buffer-util.js
var require_buffer_util = __commonJS({
  "node_modules/ws/lib/buffer-util.js"(exports, module) {
    "use strict";
    var { EMPTY_BUFFER } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    function concat(list, totalLength) {
      if (list.length === 0) return EMPTY_BUFFER;
      if (list.length === 1) return list[0];
      const target = Buffer.allocUnsafe(totalLength);
      let offset = 0;
      for (let i = 0; i < list.length; i++) {
        const buf = list[i];
        target.set(buf, offset);
        offset += buf.length;
      }
      if (offset < totalLength) {
        return new FastBuffer(target.buffer, target.byteOffset, offset);
      }
      return target;
    }
    function _mask(source, mask, output, offset, length) {
      for (let i = 0; i < length; i++) {
        output[offset + i] = source[i] ^ mask[i & 3];
      }
    }
    function _unmask(buffer, mask) {
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] ^= mask[i & 3];
      }
    }
    function toArrayBuffer(buf) {
      if (buf.length === buf.buffer.byteLength) {
        return buf.buffer;
      }
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    }
    function toBuffer(data) {
      toBuffer.readOnly = true;
      if (Buffer.isBuffer(data)) return data;
      let buf;
      if (data instanceof ArrayBuffer) {
        buf = new FastBuffer(data);
      } else if (ArrayBuffer.isView(data)) {
        buf = new FastBuffer(data.buffer, data.byteOffset, data.byteLength);
      } else {
        buf = Buffer.from(data);
        toBuffer.readOnly = false;
      }
      return buf;
    }
    module.exports = {
      concat,
      mask: _mask,
      toArrayBuffer,
      toBuffer,
      unmask: _unmask
    };
    if (!process.env.WS_NO_BUFFER_UTIL) {
      try {
        const bufferUtil = __require("bufferutil");
        module.exports.mask = function(source, mask, output, offset, length) {
          if (length < 48) _mask(source, mask, output, offset, length);
          else bufferUtil.mask(source, mask, output, offset, length);
        };
        module.exports.unmask = function(buffer, mask) {
          if (buffer.length < 32) _unmask(buffer, mask);
          else bufferUtil.unmask(buffer, mask);
        };
      } catch (e) {
      }
    }
  }
});

// node_modules/ws/lib/limiter.js
var require_limiter = __commonJS({
  "node_modules/ws/lib/limiter.js"(exports, module) {
    "use strict";
    var kDone = Symbol("kDone");
    var kRun = Symbol("kRun");
    var Limiter = class {
      /**
       * Creates a new `Limiter`.
       *
       * @param {Number} [concurrency=Infinity] The maximum number of jobs allowed
       *     to run concurrently
       */
      constructor(concurrency) {
        this[kDone] = () => {
          this.pending--;
          this[kRun]();
        };
        this.concurrency = concurrency || Infinity;
        this.jobs = [];
        this.pending = 0;
      }
      /**
       * Adds a job to the queue.
       *
       * @param {Function} job The job to run
       * @public
       */
      add(job) {
        this.jobs.push(job);
        this[kRun]();
      }
      /**
       * Removes a job from the queue and runs it if possible.
       *
       * @private
       */
      [kRun]() {
        if (this.pending === this.concurrency) return;
        if (this.jobs.length) {
          const job = this.jobs.shift();
          this.pending++;
          job(this[kDone]);
        }
      }
    };
    module.exports = Limiter;
  }
});

// node_modules/ws/lib/permessage-deflate.js
var require_permessage_deflate = __commonJS({
  "node_modules/ws/lib/permessage-deflate.js"(exports, module) {
    "use strict";
    var zlib = __require("zlib");
    var bufferUtil = require_buffer_util();
    var Limiter = require_limiter();
    var { kStatusCode } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    var TRAILER = Buffer.from([0, 0, 255, 255]);
    var kPerMessageDeflate = Symbol("permessage-deflate");
    var kTotalLength = Symbol("total-length");
    var kCallback = Symbol("callback");
    var kBuffers = Symbol("buffers");
    var kError = Symbol("error");
    var zlibLimiter;
    var PerMessageDeflate2 = class {
      /**
       * Creates a PerMessageDeflate instance.
       *
       * @param {Object} [options] Configuration options
       * @param {(Boolean|Number)} [options.clientMaxWindowBits] Advertise support
       *     for, or request, a custom client window size
       * @param {Boolean} [options.clientNoContextTakeover=false] Advertise/
       *     acknowledge disabling of client context takeover
       * @param {Number} [options.concurrencyLimit=10] The number of concurrent
       *     calls to zlib
       * @param {Boolean} [options.isServer=false] Create the instance in either
       *     server or client mode
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {(Boolean|Number)} [options.serverMaxWindowBits] Request/confirm the
       *     use of a custom server window size
       * @param {Boolean} [options.serverNoContextTakeover=false] Request/accept
       *     disabling of server context takeover
       * @param {Number} [options.threshold=1024] Size (in bytes) below which
       *     messages should not be compressed if context takeover is disabled
       * @param {Object} [options.zlibDeflateOptions] Options to pass to zlib on
       *     deflate
       * @param {Object} [options.zlibInflateOptions] Options to pass to zlib on
       *     inflate
       */
      constructor(options) {
        this._options = options || {};
        this._threshold = this._options.threshold !== void 0 ? this._options.threshold : 1024;
        this._maxPayload = this._options.maxPayload | 0;
        this._isServer = !!this._options.isServer;
        this._deflate = null;
        this._inflate = null;
        this.params = null;
        if (!zlibLimiter) {
          const concurrency = this._options.concurrencyLimit !== void 0 ? this._options.concurrencyLimit : 10;
          zlibLimiter = new Limiter(concurrency);
        }
      }
      /**
       * @type {String}
       */
      static get extensionName() {
        return "permessage-deflate";
      }
      /**
       * Create an extension negotiation offer.
       *
       * @return {Object} Extension parameters
       * @public
       */
      offer() {
        const params = {};
        if (this._options.serverNoContextTakeover) {
          params.server_no_context_takeover = true;
        }
        if (this._options.clientNoContextTakeover) {
          params.client_no_context_takeover = true;
        }
        if (this._options.serverMaxWindowBits) {
          params.server_max_window_bits = this._options.serverMaxWindowBits;
        }
        if (this._options.clientMaxWindowBits) {
          params.client_max_window_bits = this._options.clientMaxWindowBits;
        } else if (this._options.clientMaxWindowBits == null) {
          params.client_max_window_bits = true;
        }
        return params;
      }
      /**
       * Accept an extension negotiation offer/response.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Object} Accepted configuration
       * @public
       */
      accept(configurations) {
        configurations = this.normalizeParams(configurations);
        this.params = this._isServer ? this.acceptAsServer(configurations) : this.acceptAsClient(configurations);
        return this.params;
      }
      /**
       * Releases all resources used by the extension.
       *
       * @public
       */
      cleanup() {
        if (this._inflate) {
          this._inflate.close();
          this._inflate = null;
        }
        if (this._deflate) {
          const callback = this._deflate[kCallback];
          this._deflate.close();
          this._deflate = null;
          if (callback) {
            callback(
              new Error(
                "The deflate stream was closed while data was being processed"
              )
            );
          }
        }
      }
      /**
       *  Accept an extension negotiation offer.
       *
       * @param {Array} offers The extension negotiation offers
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsServer(offers) {
        const opts = this._options;
        const accepted = offers.find((params) => {
          if (opts.serverNoContextTakeover === false && params.server_no_context_takeover || params.server_max_window_bits && (opts.serverMaxWindowBits === false || typeof opts.serverMaxWindowBits === "number" && opts.serverMaxWindowBits > params.server_max_window_bits) || typeof opts.clientMaxWindowBits === "number" && !params.client_max_window_bits) {
            return false;
          }
          return true;
        });
        if (!accepted) {
          throw new Error("None of the extension offers can be accepted");
        }
        if (opts.serverNoContextTakeover) {
          accepted.server_no_context_takeover = true;
        }
        if (opts.clientNoContextTakeover) {
          accepted.client_no_context_takeover = true;
        }
        if (typeof opts.serverMaxWindowBits === "number") {
          accepted.server_max_window_bits = opts.serverMaxWindowBits;
        }
        if (typeof opts.clientMaxWindowBits === "number") {
          accepted.client_max_window_bits = opts.clientMaxWindowBits;
        } else if (accepted.client_max_window_bits === true || opts.clientMaxWindowBits === false) {
          delete accepted.client_max_window_bits;
        }
        return accepted;
      }
      /**
       * Accept the extension negotiation response.
       *
       * @param {Array} response The extension negotiation response
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsClient(response) {
        const params = response[0];
        if (this._options.clientNoContextTakeover === false && params.client_no_context_takeover) {
          throw new Error('Unexpected parameter "client_no_context_takeover"');
        }
        if (!params.client_max_window_bits) {
          if (typeof this._options.clientMaxWindowBits === "number") {
            params.client_max_window_bits = this._options.clientMaxWindowBits;
          }
        } else if (this._options.clientMaxWindowBits === false || typeof this._options.clientMaxWindowBits === "number" && params.client_max_window_bits > this._options.clientMaxWindowBits) {
          throw new Error(
            'Unexpected or invalid parameter "client_max_window_bits"'
          );
        }
        return params;
      }
      /**
       * Normalize parameters.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Array} The offers/response with normalized parameters
       * @private
       */
      normalizeParams(configurations) {
        configurations.forEach((params) => {
          Object.keys(params).forEach((key) => {
            let value = params[key];
            if (value.length > 1) {
              throw new Error(`Parameter "${key}" must have only a single value`);
            }
            value = value[0];
            if (key === "client_max_window_bits") {
              if (value !== true) {
                const num = +value;
                if (!Number.isInteger(num) || num < 8 || num > 15) {
                  throw new TypeError(
                    `Invalid value for parameter "${key}": ${value}`
                  );
                }
                value = num;
              } else if (!this._isServer) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else if (key === "server_max_window_bits") {
              const num = +value;
              if (!Number.isInteger(num) || num < 8 || num > 15) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
              value = num;
            } else if (key === "client_no_context_takeover" || key === "server_no_context_takeover") {
              if (value !== true) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else {
              throw new Error(`Unknown parameter "${key}"`);
            }
            params[key] = value;
          });
        });
        return configurations;
      }
      /**
       * Decompress data. Concurrency limited.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      decompress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._decompress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Compress data. Concurrency limited.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      compress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._compress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Decompress data.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _decompress(data, fin, callback) {
        const endpoint = this._isServer ? "client" : "server";
        if (!this._inflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._inflate = zlib.createInflateRaw({
            ...this._options.zlibInflateOptions,
            windowBits
          });
          this._inflate[kPerMessageDeflate] = this;
          this._inflate[kTotalLength] = 0;
          this._inflate[kBuffers] = [];
          this._inflate.on("error", inflateOnError);
          this._inflate.on("data", inflateOnData);
        }
        this._inflate[kCallback] = callback;
        this._inflate.write(data);
        if (fin) this._inflate.write(TRAILER);
        this._inflate.flush(() => {
          const err = this._inflate[kError];
          if (err) {
            this._inflate.close();
            this._inflate = null;
            callback(err);
            return;
          }
          const data2 = bufferUtil.concat(
            this._inflate[kBuffers],
            this._inflate[kTotalLength]
          );
          if (this._inflate._readableState.endEmitted) {
            this._inflate.close();
            this._inflate = null;
          } else {
            this._inflate[kTotalLength] = 0;
            this._inflate[kBuffers] = [];
            if (fin && this.params[`${endpoint}_no_context_takeover`]) {
              this._inflate.reset();
            }
          }
          callback(null, data2);
        });
      }
      /**
       * Compress data.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _compress(data, fin, callback) {
        const endpoint = this._isServer ? "server" : "client";
        if (!this._deflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._deflate = zlib.createDeflateRaw({
            ...this._options.zlibDeflateOptions,
            windowBits
          });
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          this._deflate.on("data", deflateOnData);
        }
        this._deflate[kCallback] = callback;
        this._deflate.write(data);
        this._deflate.flush(zlib.Z_SYNC_FLUSH, () => {
          if (!this._deflate) {
            return;
          }
          let data2 = bufferUtil.concat(
            this._deflate[kBuffers],
            this._deflate[kTotalLength]
          );
          if (fin) {
            data2 = new FastBuffer(data2.buffer, data2.byteOffset, data2.length - 4);
          }
          this._deflate[kCallback] = null;
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          if (fin && this.params[`${endpoint}_no_context_takeover`]) {
            this._deflate.reset();
          }
          callback(null, data2);
        });
      }
    };
    module.exports = PerMessageDeflate2;
    function deflateOnData(chunk) {
      this[kBuffers].push(chunk);
      this[kTotalLength] += chunk.length;
    }
    function inflateOnData(chunk) {
      this[kTotalLength] += chunk.length;
      if (this[kPerMessageDeflate]._maxPayload < 1 || this[kTotalLength] <= this[kPerMessageDeflate]._maxPayload) {
        this[kBuffers].push(chunk);
        return;
      }
      this[kError] = new RangeError("Max payload size exceeded");
      this[kError].code = "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
      this[kError][kStatusCode] = 1009;
      this.removeListener("data", inflateOnData);
      this.reset();
    }
    function inflateOnError(err) {
      this[kPerMessageDeflate]._inflate = null;
      if (this[kError]) {
        this[kCallback](this[kError]);
        return;
      }
      err[kStatusCode] = 1007;
      this[kCallback](err);
    }
  }
});

// node_modules/ws/lib/validation.js
var require_validation = __commonJS({
  "node_modules/ws/lib/validation.js"(exports, module) {
    "use strict";
    var { isUtf8 } = __require("buffer");
    var { hasBlob } = require_constants();
    var tokenChars = [
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 0 - 15
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 16 - 31
      0,
      1,
      0,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      1,
      1,
      0,
      1,
      1,
      0,
      // 32 - 47
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      // 48 - 63
      0,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 64 - 79
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      1,
      1,
      // 80 - 95
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 96 - 111
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      1,
      0,
      1,
      0
      // 112 - 127
    ];
    function isValidStatusCode(code) {
      return code >= 1e3 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006 || code >= 3e3 && code <= 4999;
    }
    function _isValidUTF8(buf) {
      const len = buf.length;
      let i = 0;
      while (i < len) {
        if ((buf[i] & 128) === 0) {
          i++;
        } else if ((buf[i] & 224) === 192) {
          if (i + 1 === len || (buf[i + 1] & 192) !== 128 || (buf[i] & 254) === 192) {
            return false;
          }
          i += 2;
        } else if ((buf[i] & 240) === 224) {
          if (i + 2 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || buf[i] === 224 && (buf[i + 1] & 224) === 128 || // Overlong
          buf[i] === 237 && (buf[i + 1] & 224) === 160) {
            return false;
          }
          i += 3;
        } else if ((buf[i] & 248) === 240) {
          if (i + 3 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || (buf[i + 3] & 192) !== 128 || buf[i] === 240 && (buf[i + 1] & 240) === 128 || // Overlong
          buf[i] === 244 && buf[i + 1] > 143 || buf[i] > 244) {
            return false;
          }
          i += 4;
        } else {
          return false;
        }
      }
      return true;
    }
    function isBlob(value) {
      return hasBlob && typeof value === "object" && typeof value.arrayBuffer === "function" && typeof value.type === "string" && typeof value.stream === "function" && (value[Symbol.toStringTag] === "Blob" || value[Symbol.toStringTag] === "File");
    }
    module.exports = {
      isBlob,
      isValidStatusCode,
      isValidUTF8: _isValidUTF8,
      tokenChars
    };
    if (isUtf8) {
      module.exports.isValidUTF8 = function(buf) {
        return buf.length < 24 ? _isValidUTF8(buf) : isUtf8(buf);
      };
    } else if (!process.env.WS_NO_UTF_8_VALIDATE) {
      try {
        const isValidUTF8 = __require("utf-8-validate");
        module.exports.isValidUTF8 = function(buf) {
          return buf.length < 32 ? _isValidUTF8(buf) : isValidUTF8(buf);
        };
      } catch (e) {
      }
    }
  }
});

// node_modules/ws/lib/receiver.js
var require_receiver = __commonJS({
  "node_modules/ws/lib/receiver.js"(exports, module) {
    "use strict";
    var { Writable } = __require("stream");
    var PerMessageDeflate2 = require_permessage_deflate();
    var {
      BINARY_TYPES,
      EMPTY_BUFFER,
      kStatusCode,
      kWebSocket
    } = require_constants();
    var { concat, toArrayBuffer, unmask } = require_buffer_util();
    var { isValidStatusCode, isValidUTF8 } = require_validation();
    var FastBuffer = Buffer[Symbol.species];
    var GET_INFO = 0;
    var GET_PAYLOAD_LENGTH_16 = 1;
    var GET_PAYLOAD_LENGTH_64 = 2;
    var GET_MASK = 3;
    var GET_DATA = 4;
    var INFLATING = 5;
    var DEFER_EVENT = 6;
    var Receiver2 = class extends Writable {
      /**
       * Creates a Receiver instance.
       *
       * @param {Object} [options] Options object
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {String} [options.binaryType=nodebuffer] The type for binary data
       * @param {Object} [options.extensions] An object containing the negotiated
       *     extensions
       * @param {Boolean} [options.isServer=false] Specifies whether to operate in
       *     client or server mode
       * @param {Number} [options.maxBufferedChunks=0] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=0] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       */
      constructor(options = {}) {
        super();
        this._allowSynchronousEvents = options.allowSynchronousEvents !== void 0 ? options.allowSynchronousEvents : true;
        this._binaryType = options.binaryType || BINARY_TYPES[0];
        this._extensions = options.extensions || {};
        this._isServer = !!options.isServer;
        this._maxBufferedChunks = options.maxBufferedChunks | 0;
        this._maxFragments = options.maxFragments | 0;
        this._maxPayload = options.maxPayload | 0;
        this._skipUTF8Validation = !!options.skipUTF8Validation;
        this[kWebSocket] = void 0;
        this._bufferedBytes = 0;
        this._buffers = [];
        this._compressed = false;
        this._payloadLength = 0;
        this._mask = void 0;
        this._fragmented = 0;
        this._masked = false;
        this._fin = false;
        this._opcode = 0;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragments = [];
        this._errored = false;
        this._loop = false;
        this._state = GET_INFO;
      }
      /**
       * Implements `Writable.prototype._write()`.
       *
       * @param {Buffer} chunk The chunk of data to write
       * @param {String} encoding The character encoding of `chunk`
       * @param {Function} cb Callback
       * @private
       */
      _write(chunk, encoding, cb) {
        if (this._opcode === 8 && this._state == GET_INFO) return cb();
        if (this._maxBufferedChunks > 0 && this._buffers.length >= this._maxBufferedChunks) {
          cb(
            this.createError(
              RangeError,
              "Too many buffered chunks",
              false,
              1008,
              "WS_ERR_TOO_MANY_BUFFERED_PARTS"
            )
          );
          return;
        }
        this._bufferedBytes += chunk.length;
        this._buffers.push(chunk);
        this.startLoop(cb);
      }
      /**
       * Consumes `n` bytes from the buffered data.
       *
       * @param {Number} n The number of bytes to consume
       * @return {Buffer} The consumed bytes
       * @private
       */
      consume(n) {
        this._bufferedBytes -= n;
        if (n === this._buffers[0].length) return this._buffers.shift();
        if (n < this._buffers[0].length) {
          const buf = this._buffers[0];
          this._buffers[0] = new FastBuffer(
            buf.buffer,
            buf.byteOffset + n,
            buf.length - n
          );
          return new FastBuffer(buf.buffer, buf.byteOffset, n);
        }
        const dst = Buffer.allocUnsafe(n);
        do {
          const buf = this._buffers[0];
          const offset = dst.length - n;
          if (n >= buf.length) {
            dst.set(this._buffers.shift(), offset);
          } else {
            dst.set(new Uint8Array(buf.buffer, buf.byteOffset, n), offset);
            this._buffers[0] = new FastBuffer(
              buf.buffer,
              buf.byteOffset + n,
              buf.length - n
            );
          }
          n -= buf.length;
        } while (n > 0);
        return dst;
      }
      /**
       * Starts the parsing loop.
       *
       * @param {Function} cb Callback
       * @private
       */
      startLoop(cb) {
        this._loop = true;
        do {
          switch (this._state) {
            case GET_INFO:
              this.getInfo(cb);
              break;
            case GET_PAYLOAD_LENGTH_16:
              this.getPayloadLength16(cb);
              break;
            case GET_PAYLOAD_LENGTH_64:
              this.getPayloadLength64(cb);
              break;
            case GET_MASK:
              this.getMask();
              break;
            case GET_DATA:
              this.getData(cb);
              break;
            case INFLATING:
            case DEFER_EVENT:
              this._loop = false;
              return;
          }
        } while (this._loop);
        if (!this._errored) cb();
      }
      /**
       * Reads the first two bytes of a frame.
       *
       * @param {Function} cb Callback
       * @private
       */
      getInfo(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        const buf = this.consume(2);
        if ((buf[0] & 48) !== 0) {
          const error = this.createError(
            RangeError,
            "RSV2 and RSV3 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_2_3"
          );
          cb(error);
          return;
        }
        const compressed = (buf[0] & 64) === 64;
        if (compressed && !this._extensions[PerMessageDeflate2.extensionName]) {
          const error = this.createError(
            RangeError,
            "RSV1 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_1"
          );
          cb(error);
          return;
        }
        this._fin = (buf[0] & 128) === 128;
        this._opcode = buf[0] & 15;
        this._payloadLength = buf[1] & 127;
        if (this._opcode === 0) {
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (!this._fragmented) {
            const error = this.createError(
              RangeError,
              "invalid opcode 0",
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._opcode = this._fragmented;
        } else if (this._opcode === 1 || this._opcode === 2) {
          if (this._fragmented) {
            const error = this.createError(
              RangeError,
              `invalid opcode ${this._opcode}`,
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._compressed = compressed;
        } else if (this._opcode > 7 && this._opcode < 11) {
          if (!this._fin) {
            const error = this.createError(
              RangeError,
              "FIN must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_FIN"
            );
            cb(error);
            return;
          }
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (this._payloadLength > 125 || this._opcode === 8 && this._payloadLength === 1) {
            const error = this.createError(
              RangeError,
              `invalid payload length ${this._payloadLength}`,
              true,
              1002,
              "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH"
            );
            cb(error);
            return;
          }
        } else {
          const error = this.createError(
            RangeError,
            `invalid opcode ${this._opcode}`,
            true,
            1002,
            "WS_ERR_INVALID_OPCODE"
          );
          cb(error);
          return;
        }
        if (!this._fin && !this._fragmented) this._fragmented = this._opcode;
        this._masked = (buf[1] & 128) === 128;
        if (this._isServer) {
          if (!this._masked) {
            const error = this.createError(
              RangeError,
              "MASK must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_MASK"
            );
            cb(error);
            return;
          }
        } else if (this._masked) {
          const error = this.createError(
            RangeError,
            "MASK must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_MASK"
          );
          cb(error);
          return;
        }
        if (this._payloadLength === 126) this._state = GET_PAYLOAD_LENGTH_16;
        else if (this._payloadLength === 127) this._state = GET_PAYLOAD_LENGTH_64;
        else this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+16).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength16(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        this._payloadLength = this.consume(2).readUInt16BE(0);
        this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+64).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength64(cb) {
        if (this._bufferedBytes < 8) {
          this._loop = false;
          return;
        }
        const buf = this.consume(8);
        const num = buf.readUInt32BE(0);
        if (num > Math.pow(2, 53 - 32) - 1) {
          const error = this.createError(
            RangeError,
            "Unsupported WebSocket frame: payload length > 2^53 - 1",
            false,
            1009,
            "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH"
          );
          cb(error);
          return;
        }
        this._payloadLength = num * Math.pow(2, 32) + buf.readUInt32BE(4);
        this.haveLength(cb);
      }
      /**
       * Payload length has been read.
       *
       * @param {Function} cb Callback
       * @private
       */
      haveLength(cb) {
        if (this._payloadLength && this._opcode < 8) {
          this._totalPayloadLength += this._payloadLength;
          if (this._totalPayloadLength > this._maxPayload && this._maxPayload > 0) {
            const error = this.createError(
              RangeError,
              "Max payload size exceeded",
              false,
              1009,
              "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
            );
            cb(error);
            return;
          }
        }
        if (this._masked) this._state = GET_MASK;
        else this._state = GET_DATA;
      }
      /**
       * Reads mask bytes.
       *
       * @private
       */
      getMask() {
        if (this._bufferedBytes < 4) {
          this._loop = false;
          return;
        }
        this._mask = this.consume(4);
        this._state = GET_DATA;
      }
      /**
       * Reads data bytes.
       *
       * @param {Function} cb Callback
       * @private
       */
      getData(cb) {
        let data = EMPTY_BUFFER;
        if (this._payloadLength) {
          if (this._bufferedBytes < this._payloadLength) {
            this._loop = false;
            return;
          }
          data = this.consume(this._payloadLength);
          if (this._masked && (this._mask[0] | this._mask[1] | this._mask[2] | this._mask[3]) !== 0) {
            unmask(data, this._mask);
          }
        }
        if (this._opcode > 7) {
          this.controlMessage(data, cb);
          return;
        }
        if (this._compressed) {
          this._state = INFLATING;
          this.decompress(data, cb);
          return;
        }
        if (data.length) {
          if (this._maxFragments > 0 && this._fragments.length >= this._maxFragments) {
            const error = this.createError(
              RangeError,
              "Too many message fragments",
              false,
              1008,
              "WS_ERR_TOO_MANY_BUFFERED_PARTS"
            );
            cb(error);
            return;
          }
          this._messageLength = this._totalPayloadLength;
          this._fragments.push(data);
        }
        this.dataMessage(cb);
      }
      /**
       * Decompresses data.
       *
       * @param {Buffer} data Compressed data
       * @param {Function} cb Callback
       * @private
       */
      decompress(data, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        perMessageDeflate.decompress(data, this._fin, (err, buf) => {
          if (err) return cb(err);
          if (buf.length) {
            this._messageLength += buf.length;
            if (this._messageLength > this._maxPayload && this._maxPayload > 0) {
              const error = this.createError(
                RangeError,
                "Max payload size exceeded",
                false,
                1009,
                "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
              );
              cb(error);
              return;
            }
            if (this._maxFragments > 0 && this._fragments.length >= this._maxFragments) {
              const error = this.createError(
                RangeError,
                "Too many message fragments",
                false,
                1008,
                "WS_ERR_TOO_MANY_BUFFERED_PARTS"
              );
              cb(error);
              return;
            }
            this._fragments.push(buf);
          }
          this.dataMessage(cb);
          if (this._state === GET_INFO) this.startLoop(cb);
        });
      }
      /**
       * Handles a data message.
       *
       * @param {Function} cb Callback
       * @private
       */
      dataMessage(cb) {
        if (!this._fin) {
          this._state = GET_INFO;
          return;
        }
        const messageLength = this._messageLength;
        const fragments = this._fragments;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragmented = 0;
        this._fragments = [];
        if (this._opcode === 2) {
          let data;
          if (this._binaryType === "nodebuffer") {
            data = concat(fragments, messageLength);
          } else if (this._binaryType === "arraybuffer") {
            data = toArrayBuffer(concat(fragments, messageLength));
          } else if (this._binaryType === "blob") {
            data = new Blob(fragments);
          } else {
            data = fragments;
          }
          if (this._allowSynchronousEvents) {
            this.emit("message", data, true);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", data, true);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        } else {
          const buf = concat(fragments, messageLength);
          if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
            const error = this.createError(
              Error,
              "invalid UTF-8 sequence",
              true,
              1007,
              "WS_ERR_INVALID_UTF8"
            );
            cb(error);
            return;
          }
          if (this._state === INFLATING || this._allowSynchronousEvents) {
            this.emit("message", buf, false);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", buf, false);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        }
      }
      /**
       * Handles a control message.
       *
       * @param {Buffer} data Data to handle
       * @return {(Error|RangeError|undefined)} A possible error
       * @private
       */
      controlMessage(data, cb) {
        if (this._opcode === 8) {
          if (data.length === 0) {
            this._loop = false;
            this.emit("conclude", 1005, EMPTY_BUFFER);
            this.end();
          } else {
            const code = data.readUInt16BE(0);
            if (!isValidStatusCode(code)) {
              const error = this.createError(
                RangeError,
                `invalid status code ${code}`,
                true,
                1002,
                "WS_ERR_INVALID_CLOSE_CODE"
              );
              cb(error);
              return;
            }
            const buf = new FastBuffer(
              data.buffer,
              data.byteOffset + 2,
              data.length - 2
            );
            if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
              const error = this.createError(
                Error,
                "invalid UTF-8 sequence",
                true,
                1007,
                "WS_ERR_INVALID_UTF8"
              );
              cb(error);
              return;
            }
            this._loop = false;
            this.emit("conclude", code, buf);
            this.end();
          }
          this._state = GET_INFO;
          return;
        }
        if (this._allowSynchronousEvents) {
          this.emit(this._opcode === 9 ? "ping" : "pong", data);
          this._state = GET_INFO;
        } else {
          this._state = DEFER_EVENT;
          setImmediate(() => {
            this.emit(this._opcode === 9 ? "ping" : "pong", data);
            this._state = GET_INFO;
            this.startLoop(cb);
          });
        }
      }
      /**
       * Builds an error object.
       *
       * @param {function(new:Error|RangeError)} ErrorCtor The error constructor
       * @param {String} message The error message
       * @param {Boolean} prefix Specifies whether or not to add a default prefix to
       *     `message`
       * @param {Number} statusCode The status code
       * @param {String} errorCode The exposed error code
       * @return {(Error|RangeError)} The error
       * @private
       */
      createError(ErrorCtor, message, prefix, statusCode, errorCode) {
        this._loop = false;
        this._errored = true;
        const err = new ErrorCtor(
          prefix ? `Invalid WebSocket frame: ${message}` : message
        );
        Error.captureStackTrace(err, this.createError);
        err.code = errorCode;
        err[kStatusCode] = statusCode;
        return err;
      }
    };
    module.exports = Receiver2;
  }
});

// node_modules/ws/lib/sender.js
var require_sender = __commonJS({
  "node_modules/ws/lib/sender.js"(exports, module) {
    "use strict";
    var { Duplex } = __require("stream");
    var { randomFillSync } = __require("crypto");
    var {
      types: { isUint8Array }
    } = __require("util");
    var PerMessageDeflate2 = require_permessage_deflate();
    var { EMPTY_BUFFER, kWebSocket, NOOP } = require_constants();
    var { isBlob, isValidStatusCode } = require_validation();
    var { mask: applyMask, toBuffer } = require_buffer_util();
    var kByteLength = Symbol("kByteLength");
    var maskBuffer = Buffer.alloc(4);
    var RANDOM_POOL_SIZE = 8 * 1024;
    var randomPool;
    var randomPoolPointer = RANDOM_POOL_SIZE;
    var DEFAULT = 0;
    var DEFLATING = 1;
    var GET_BLOB_DATA = 2;
    var Sender2 = class _Sender {
      /**
       * Creates a Sender instance.
       *
       * @param {Duplex} socket The connection socket
       * @param {Object} [extensions] An object containing the negotiated extensions
       * @param {Function} [generateMask] The function used to generate the masking
       *     key
       */
      constructor(socket, extensions, generateMask) {
        this._extensions = extensions || {};
        if (generateMask) {
          this._generateMask = generateMask;
          this._maskBuffer = Buffer.alloc(4);
        }
        this._socket = socket;
        this._firstFragment = true;
        this._compress = false;
        this._bufferedBytes = 0;
        this._queue = [];
        this._state = DEFAULT;
        this.onerror = NOOP;
        this[kWebSocket] = void 0;
      }
      /**
       * Frames a piece of data according to the HyBi WebSocket protocol.
       *
       * @param {(Buffer|String)} data The data to frame
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @return {(Buffer|String)[]} The framed data
       * @public
       */
      static frame(data, options) {
        let mask;
        let merge = false;
        let offset = 2;
        let skipMasking = false;
        if (options.mask) {
          mask = options.maskBuffer || maskBuffer;
          if (options.generateMask) {
            options.generateMask(mask);
          } else {
            if (randomPoolPointer === RANDOM_POOL_SIZE) {
              if (randomPool === void 0) {
                randomPool = Buffer.alloc(RANDOM_POOL_SIZE);
              }
              randomFillSync(randomPool, 0, RANDOM_POOL_SIZE);
              randomPoolPointer = 0;
            }
            mask[0] = randomPool[randomPoolPointer++];
            mask[1] = randomPool[randomPoolPointer++];
            mask[2] = randomPool[randomPoolPointer++];
            mask[3] = randomPool[randomPoolPointer++];
          }
          skipMasking = (mask[0] | mask[1] | mask[2] | mask[3]) === 0;
          offset = 6;
        }
        let dataLength;
        if (typeof data === "string") {
          if ((!options.mask || skipMasking) && options[kByteLength] !== void 0) {
            dataLength = options[kByteLength];
          } else {
            data = Buffer.from(data);
            dataLength = data.length;
          }
        } else {
          dataLength = data.length;
          merge = options.mask && options.readOnly && !skipMasking;
        }
        let payloadLength = dataLength;
        if (dataLength >= 65536) {
          offset += 8;
          payloadLength = 127;
        } else if (dataLength > 125) {
          offset += 2;
          payloadLength = 126;
        }
        const target = Buffer.allocUnsafe(merge ? dataLength + offset : offset);
        target[0] = options.fin ? options.opcode | 128 : options.opcode;
        if (options.rsv1) target[0] |= 64;
        target[1] = payloadLength;
        if (payloadLength === 126) {
          target.writeUInt16BE(dataLength, 2);
        } else if (payloadLength === 127) {
          target[2] = target[3] = 0;
          target.writeUIntBE(dataLength, 4, 6);
        }
        if (!options.mask) return [target, data];
        target[1] |= 128;
        target[offset - 4] = mask[0];
        target[offset - 3] = mask[1];
        target[offset - 2] = mask[2];
        target[offset - 1] = mask[3];
        if (skipMasking) return [target, data];
        if (merge) {
          applyMask(data, mask, target, offset, dataLength);
          return [target];
        }
        applyMask(data, mask, data, 0, dataLength);
        return [target, data];
      }
      /**
       * Sends a close message to the other peer.
       *
       * @param {Number} [code] The status code component of the body
       * @param {(String|Buffer)} [data] The message component of the body
       * @param {Boolean} [mask=false] Specifies whether or not to mask the message
       * @param {Function} [cb] Callback
       * @public
       */
      close(code, data, mask, cb) {
        let buf;
        if (code === void 0) {
          buf = EMPTY_BUFFER;
        } else if (typeof code !== "number" || !isValidStatusCode(code)) {
          throw new TypeError("First argument must be a valid error code number");
        } else if (data === void 0 || !data.length) {
          buf = Buffer.allocUnsafe(2);
          buf.writeUInt16BE(code, 0);
        } else {
          const length = Buffer.byteLength(data);
          if (length > 123) {
            throw new RangeError("The message must not be greater than 123 bytes");
          }
          buf = Buffer.allocUnsafe(2 + length);
          buf.writeUInt16BE(code, 0);
          if (typeof data === "string") {
            buf.write(data, 2);
          } else if (isUint8Array(data)) {
            buf.set(data, 2);
          } else {
            throw new TypeError("Second argument must be a string or a Uint8Array");
          }
        }
        const options = {
          [kByteLength]: buf.length,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 8,
          readOnly: false,
          rsv1: false
        };
        if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, buf, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(buf, options), cb);
        }
      }
      /**
       * Sends a ping message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      ping(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 9,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a pong message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      pong(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 10,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a data message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Object} options Options object
       * @param {Boolean} [options.binary=false] Specifies whether `data` is binary
       *     or text
       * @param {Boolean} [options.compress=false] Specifies whether or not to
       *     compress `data`
       * @param {Boolean} [options.fin=false] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Function} [cb] Callback
       * @public
       */
      send(data, options, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        let opcode = options.binary ? 2 : 1;
        let rsv1 = options.compress;
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (this._firstFragment) {
          this._firstFragment = false;
          if (rsv1 && perMessageDeflate && perMessageDeflate.params[perMessageDeflate._isServer ? "server_no_context_takeover" : "client_no_context_takeover"]) {
            rsv1 = byteLength >= perMessageDeflate._threshold;
          }
          this._compress = rsv1;
        } else {
          rsv1 = false;
          opcode = 0;
        }
        if (options.fin) this._firstFragment = true;
        const opts = {
          [kByteLength]: byteLength,
          fin: options.fin,
          generateMask: this._generateMask,
          mask: options.mask,
          maskBuffer: this._maskBuffer,
          opcode,
          readOnly,
          rsv1
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, this._compress, opts, cb]);
          } else {
            this.getBlobData(data, this._compress, opts, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, this._compress, opts, cb]);
        } else {
          this.dispatch(data, this._compress, opts, cb);
        }
      }
      /**
       * Gets the contents of a blob as binary data.
       *
       * @param {Blob} blob The blob
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     the data
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      getBlobData(blob, compress, options, cb) {
        this._bufferedBytes += options[kByteLength];
        this._state = GET_BLOB_DATA;
        blob.arrayBuffer().then((arrayBuffer) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while the blob was being read"
            );
            process.nextTick(callCallbacks, this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          const data = toBuffer(arrayBuffer);
          if (!compress) {
            this._state = DEFAULT;
            this.sendFrame(_Sender.frame(data, options), cb);
            this.dequeue();
          } else {
            this.dispatch(data, compress, options, cb);
          }
        }).catch((err) => {
          process.nextTick(onError, this, err, cb);
        });
      }
      /**
       * Dispatches a message.
       *
       * @param {(Buffer|String)} data The message to send
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     `data`
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      dispatch(data, compress, options, cb) {
        if (!compress) {
          this.sendFrame(_Sender.frame(data, options), cb);
          return;
        }
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        this._bufferedBytes += options[kByteLength];
        this._state = DEFLATING;
        perMessageDeflate.compress(data, options.fin, (_, buf) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while data was being compressed"
            );
            callCallbacks(this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          this._state = DEFAULT;
          options.readOnly = false;
          this.sendFrame(_Sender.frame(buf, options), cb);
          this.dequeue();
        });
      }
      /**
       * Executes queued send operations.
       *
       * @private
       */
      dequeue() {
        while (this._state === DEFAULT && this._queue.length) {
          const params = this._queue.shift();
          this._bufferedBytes -= params[3][kByteLength];
          Reflect.apply(params[0], this, params.slice(1));
        }
      }
      /**
       * Enqueues a send operation.
       *
       * @param {Array} params Send operation parameters.
       * @private
       */
      enqueue(params) {
        this._bufferedBytes += params[3][kByteLength];
        this._queue.push(params);
      }
      /**
       * Sends a frame.
       *
       * @param {(Buffer | String)[]} list The frame to send
       * @param {Function} [cb] Callback
       * @private
       */
      sendFrame(list, cb) {
        if (list.length === 2) {
          this._socket.cork();
          this._socket.write(list[0]);
          this._socket.write(list[1], cb);
          this._socket.uncork();
        } else {
          this._socket.write(list[0], cb);
        }
      }
    };
    module.exports = Sender2;
    function callCallbacks(sender, err, cb) {
      if (typeof cb === "function") cb(err);
      for (let i = 0; i < sender._queue.length; i++) {
        const params = sender._queue[i];
        const callback = params[params.length - 1];
        if (typeof callback === "function") callback(err);
      }
    }
    function onError(sender, err, cb) {
      callCallbacks(sender, err, cb);
      sender.onerror(err);
    }
  }
});

// node_modules/ws/lib/event-target.js
var require_event_target = __commonJS({
  "node_modules/ws/lib/event-target.js"(exports, module) {
    "use strict";
    var { kForOnEventAttribute, kListener } = require_constants();
    var kCode = Symbol("kCode");
    var kData = Symbol("kData");
    var kError = Symbol("kError");
    var kMessage = Symbol("kMessage");
    var kReason = Symbol("kReason");
    var kTarget = Symbol("kTarget");
    var kType = Symbol("kType");
    var kWasClean = Symbol("kWasClean");
    var Event = class {
      /**
       * Create a new `Event`.
       *
       * @param {String} type The name of the event
       * @throws {TypeError} If the `type` argument is not specified
       */
      constructor(type) {
        this[kTarget] = null;
        this[kType] = type;
      }
      /**
       * @type {*}
       */
      get target() {
        return this[kTarget];
      }
      /**
       * @type {String}
       */
      get type() {
        return this[kType];
      }
    };
    Object.defineProperty(Event.prototype, "target", { enumerable: true });
    Object.defineProperty(Event.prototype, "type", { enumerable: true });
    var CloseEvent = class extends Event {
      /**
       * Create a new `CloseEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {Number} [options.code=0] The status code explaining why the
       *     connection was closed
       * @param {String} [options.reason=''] A human-readable string explaining why
       *     the connection was closed
       * @param {Boolean} [options.wasClean=false] Indicates whether or not the
       *     connection was cleanly closed
       */
      constructor(type, options = {}) {
        super(type);
        this[kCode] = options.code === void 0 ? 0 : options.code;
        this[kReason] = options.reason === void 0 ? "" : options.reason;
        this[kWasClean] = options.wasClean === void 0 ? false : options.wasClean;
      }
      /**
       * @type {Number}
       */
      get code() {
        return this[kCode];
      }
      /**
       * @type {String}
       */
      get reason() {
        return this[kReason];
      }
      /**
       * @type {Boolean}
       */
      get wasClean() {
        return this[kWasClean];
      }
    };
    Object.defineProperty(CloseEvent.prototype, "code", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "reason", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "wasClean", { enumerable: true });
    var ErrorEvent = class extends Event {
      /**
       * Create a new `ErrorEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.error=null] The error that generated this event
       * @param {String} [options.message=''] The error message
       */
      constructor(type, options = {}) {
        super(type);
        this[kError] = options.error === void 0 ? null : options.error;
        this[kMessage] = options.message === void 0 ? "" : options.message;
      }
      /**
       * @type {*}
       */
      get error() {
        return this[kError];
      }
      /**
       * @type {String}
       */
      get message() {
        return this[kMessage];
      }
    };
    Object.defineProperty(ErrorEvent.prototype, "error", { enumerable: true });
    Object.defineProperty(ErrorEvent.prototype, "message", { enumerable: true });
    var MessageEvent = class extends Event {
      /**
       * Create a new `MessageEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.data=null] The message content
       */
      constructor(type, options = {}) {
        super(type);
        this[kData] = options.data === void 0 ? null : options.data;
      }
      /**
       * @type {*}
       */
      get data() {
        return this[kData];
      }
    };
    Object.defineProperty(MessageEvent.prototype, "data", { enumerable: true });
    var EventTarget = {
      /**
       * Register an event listener.
       *
       * @param {String} type A string representing the event type to listen for
       * @param {(Function|Object)} handler The listener to add
       * @param {Object} [options] An options object specifies characteristics about
       *     the event listener
       * @param {Boolean} [options.once=false] A `Boolean` indicating that the
       *     listener should be invoked at most once after being added. If `true`,
       *     the listener would be automatically removed when invoked.
       * @public
       */
      addEventListener(type, handler, options = {}) {
        for (const listener of this.listeners(type)) {
          if (!options[kForOnEventAttribute] && listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            return;
          }
        }
        let wrapper;
        if (type === "message") {
          wrapper = function onMessage(data, isBinary) {
            const event = new MessageEvent("message", {
              data: isBinary ? data : data.toString()
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "close") {
          wrapper = function onClose(code, message) {
            const event = new CloseEvent("close", {
              code,
              reason: message.toString(),
              wasClean: this._closeFrameReceived && this._closeFrameSent
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "error") {
          wrapper = function onError(error) {
            const event = new ErrorEvent("error", {
              error,
              message: error.message
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "open") {
          wrapper = function onOpen() {
            const event = new Event("open");
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else {
          return;
        }
        wrapper[kForOnEventAttribute] = !!options[kForOnEventAttribute];
        wrapper[kListener] = handler;
        if (options.once) {
          this.once(type, wrapper);
        } else {
          this.on(type, wrapper);
        }
      },
      /**
       * Remove an event listener.
       *
       * @param {String} type A string representing the event type to remove
       * @param {(Function|Object)} handler The listener to remove
       * @public
       */
      removeEventListener(type, handler) {
        for (const listener of this.listeners(type)) {
          if (listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            this.removeListener(type, listener);
            break;
          }
        }
      }
    };
    module.exports = {
      CloseEvent,
      ErrorEvent,
      Event,
      EventTarget,
      MessageEvent
    };
    function callListener(listener, thisArg, event) {
      if (typeof listener === "object" && listener.handleEvent) {
        listener.handleEvent.call(listener, event);
      } else {
        listener.call(thisArg, event);
      }
    }
  }
});

// node_modules/ws/lib/extension.js
var require_extension = __commonJS({
  "node_modules/ws/lib/extension.js"(exports, module) {
    "use strict";
    var { tokenChars } = require_validation();
    function push(dest, name, elem) {
      if (dest[name] === void 0) dest[name] = [elem];
      else dest[name].push(elem);
    }
    function parse(header) {
      const offers = /* @__PURE__ */ Object.create(null);
      let params = /* @__PURE__ */ Object.create(null);
      let mustUnescape = false;
      let isEscaping = false;
      let inQuotes = false;
      let extensionName;
      let paramName;
      let start = -1;
      let code = -1;
      let end = -1;
      let i = 0;
      for (; i < header.length; i++) {
        code = header.charCodeAt(i);
        if (extensionName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (i !== 0 && (code === 32 || code === 9)) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            const name = header.slice(start, end);
            if (code === 44) {
              push(offers, name, params);
              params = /* @__PURE__ */ Object.create(null);
            } else {
              extensionName = name;
            }
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else if (paramName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (code === 32 || code === 9) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            push(params, header.slice(start, end), true);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            start = end = -1;
          } else if (code === 61 && start !== -1 && end === -1) {
            paramName = header.slice(start, i);
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else {
          if (isEscaping) {
            if (tokenChars[code] !== 1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (start === -1) start = i;
            else if (!mustUnescape) mustUnescape = true;
            isEscaping = false;
          } else if (inQuotes) {
            if (tokenChars[code] === 1) {
              if (start === -1) start = i;
            } else if (code === 34 && start !== -1) {
              inQuotes = false;
              end = i;
            } else if (code === 92) {
              isEscaping = true;
            } else {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
          } else if (code === 34 && header.charCodeAt(i - 1) === 61) {
            inQuotes = true;
          } else if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (start !== -1 && (code === 32 || code === 9)) {
            if (end === -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            let value = header.slice(start, end);
            if (mustUnescape) {
              value = value.replace(/\\/g, "");
              mustUnescape = false;
            }
            push(params, paramName, value);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            paramName = void 0;
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        }
      }
      if (start === -1 || inQuotes || code === 32 || code === 9) {
        throw new SyntaxError("Unexpected end of input");
      }
      if (end === -1) end = i;
      const token = header.slice(start, end);
      if (extensionName === void 0) {
        push(offers, token, params);
      } else {
        if (paramName === void 0) {
          push(params, token, true);
        } else if (mustUnescape) {
          push(params, paramName, token.replace(/\\/g, ""));
        } else {
          push(params, paramName, token);
        }
        push(offers, extensionName, params);
      }
      return offers;
    }
    function format(extensions) {
      return Object.keys(extensions).map((extension2) => {
        let configurations = extensions[extension2];
        if (!Array.isArray(configurations)) configurations = [configurations];
        return configurations.map((params) => {
          return [extension2].concat(
            Object.keys(params).map((k) => {
              let values = params[k];
              if (!Array.isArray(values)) values = [values];
              return values.map((v) => v === true ? k : `${k}=${v}`).join("; ");
            })
          ).join("; ");
        }).join(", ");
      }).join(", ");
    }
    module.exports = { format, parse };
  }
});

// node_modules/ws/lib/websocket.js
var require_websocket = __commonJS({
  "node_modules/ws/lib/websocket.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events");
    var https = __require("https");
    var http = __require("http");
    var net = __require("net");
    var tls = __require("tls");
    var { randomBytes: randomBytes2, createHash } = __require("crypto");
    var { Duplex, Readable } = __require("stream");
    var { URL } = __require("url");
    var PerMessageDeflate2 = require_permessage_deflate();
    var Receiver2 = require_receiver();
    var Sender2 = require_sender();
    var { isBlob } = require_validation();
    var {
      BINARY_TYPES,
      CLOSE_TIMEOUT,
      EMPTY_BUFFER,
      GUID,
      kForOnEventAttribute,
      kListener,
      kStatusCode,
      kWebSocket,
      NOOP
    } = require_constants();
    var {
      EventTarget: { addEventListener, removeEventListener }
    } = require_event_target();
    var { format, parse } = require_extension();
    var { toBuffer } = require_buffer_util();
    var kAborted = Symbol("kAborted");
    var protocolVersions = [8, 13];
    var readyStates = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
    var subprotocolRegex = /^[!#$%&'*+\-.0-9A-Z^_`|a-z~]+$/;
    var WebSocket2 = class _WebSocket extends EventEmitter {
      /**
       * Create a new `WebSocket`.
       *
       * @param {(String|URL)} address The URL to which to connect
       * @param {(String|String[])} [protocols] The subprotocols
       * @param {Object} [options] Connection options
       */
      constructor(address, protocols, options) {
        super();
        this._binaryType = BINARY_TYPES[0];
        this._closeCode = 1006;
        this._closeFrameReceived = false;
        this._closeFrameSent = false;
        this._closeMessage = EMPTY_BUFFER;
        this._closeTimer = null;
        this._errorEmitted = false;
        this._extensions = {};
        this._paused = false;
        this._protocol = "";
        this._readyState = _WebSocket.CONNECTING;
        this._receiver = null;
        this._sender = null;
        this._socket = null;
        if (address !== null) {
          this._bufferedAmount = 0;
          this._isServer = false;
          this._redirects = 0;
          if (protocols === void 0) {
            protocols = [];
          } else if (!Array.isArray(protocols)) {
            if (typeof protocols === "object" && protocols !== null) {
              options = protocols;
              protocols = [];
            } else {
              protocols = [protocols];
            }
          }
          initAsClient(this, address, protocols, options);
        } else {
          this._autoPong = options.autoPong;
          this._closeTimeout = options.closeTimeout;
          this._isServer = true;
        }
      }
      /**
       * For historical reasons, the custom "nodebuffer" type is used by the default
       * instead of "blob".
       *
       * @type {String}
       */
      get binaryType() {
        return this._binaryType;
      }
      set binaryType(type) {
        if (!BINARY_TYPES.includes(type)) return;
        this._binaryType = type;
        if (this._receiver) this._receiver._binaryType = type;
      }
      /**
       * @type {Number}
       */
      get bufferedAmount() {
        if (!this._socket) return this._bufferedAmount;
        return this._socket._writableState.length + this._sender._bufferedBytes;
      }
      /**
       * @type {String}
       */
      get extensions() {
        return Object.keys(this._extensions).join();
      }
      /**
       * @type {Boolean}
       */
      get isPaused() {
        return this._paused;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onclose() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onerror() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onopen() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onmessage() {
        return null;
      }
      /**
       * @type {String}
       */
      get protocol() {
        return this._protocol;
      }
      /**
       * @type {Number}
       */
      get readyState() {
        return this._readyState;
      }
      /**
       * @type {String}
       */
      get url() {
        return this._url;
      }
      /**
       * Set up the socket and the internal resources.
       *
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Object} options Options object
       * @param {Boolean} [options.allowSynchronousEvents=false] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Number} [options.maxBufferedChunks=0] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=0] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=0] The maximum allowed message size
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @private
       */
      setSocket(socket, head, options) {
        const receiver = new Receiver2({
          allowSynchronousEvents: options.allowSynchronousEvents,
          binaryType: this.binaryType,
          extensions: this._extensions,
          isServer: this._isServer,
          maxBufferedChunks: options.maxBufferedChunks,
          maxFragments: options.maxFragments,
          maxPayload: options.maxPayload,
          skipUTF8Validation: options.skipUTF8Validation
        });
        const sender = new Sender2(socket, this._extensions, options.generateMask);
        this._receiver = receiver;
        this._sender = sender;
        this._socket = socket;
        receiver[kWebSocket] = this;
        sender[kWebSocket] = this;
        socket[kWebSocket] = this;
        receiver.on("conclude", receiverOnConclude);
        receiver.on("drain", receiverOnDrain);
        receiver.on("error", receiverOnError);
        receiver.on("message", receiverOnMessage);
        receiver.on("ping", receiverOnPing);
        receiver.on("pong", receiverOnPong);
        sender.onerror = senderOnError;
        if (socket.setTimeout) socket.setTimeout(0);
        if (socket.setNoDelay) socket.setNoDelay();
        if (head.length > 0) socket.unshift(head);
        socket.on("close", socketOnClose);
        socket.on("data", socketOnData);
        socket.on("end", socketOnEnd);
        socket.on("error", socketOnError);
        this._readyState = _WebSocket.OPEN;
        this.emit("open");
      }
      /**
       * Emit the `'close'` event.
       *
       * @private
       */
      emitClose() {
        if (!this._socket) {
          this._readyState = _WebSocket.CLOSED;
          this.emit("close", this._closeCode, this._closeMessage);
          return;
        }
        if (this._extensions[PerMessageDeflate2.extensionName]) {
          this._extensions[PerMessageDeflate2.extensionName].cleanup();
        }
        this._receiver.removeAllListeners();
        this._readyState = _WebSocket.CLOSED;
        this.emit("close", this._closeCode, this._closeMessage);
      }
      /**
       * Start a closing handshake.
       *
       *          +----------+   +-----------+   +----------+
       *     - - -|ws.close()|-->|close frame|-->|ws.close()|- - -
       *    |     +----------+   +-----------+   +----------+     |
       *          +----------+   +-----------+         |
       * CLOSING  |ws.close()|<--|close frame|<--+-----+       CLOSING
       *          +----------+   +-----------+   |
       *    |           |                        |   +---+        |
       *                +------------------------+-->|fin| - - - -
       *    |         +---+                      |   +---+
       *     - - - - -|fin|<---------------------+
       *              +---+
       *
       * @param {Number} [code] Status code explaining why the connection is closing
       * @param {(String|Buffer)} [data] The reason why the connection is
       *     closing
       * @public
       */
      close(code, data) {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this.readyState === _WebSocket.CLOSING) {
          if (this._closeFrameSent && (this._closeFrameReceived || this._receiver._writableState.errorEmitted)) {
            this._socket.end();
          }
          return;
        }
        this._readyState = _WebSocket.CLOSING;
        this._sender.close(code, data, !this._isServer, (err) => {
          if (err) return;
          this._closeFrameSent = true;
          if (this._closeFrameReceived || this._receiver._writableState.errorEmitted) {
            this._socket.end();
          }
        });
        setCloseTimer(this);
      }
      /**
       * Pause the socket.
       *
       * @public
       */
      pause() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = true;
        this._socket.pause();
      }
      /**
       * Send a ping.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the ping is sent
       * @public
       */
      ping(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.ping(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Send a pong.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the pong is sent
       * @public
       */
      pong(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.pong(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Resume the socket.
       *
       * @public
       */
      resume() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = false;
        if (!this._receiver._writableState.needDrain) this._socket.resume();
      }
      /**
       * Send a data message.
       *
       * @param {*} data The message to send
       * @param {Object} [options] Options object
       * @param {Boolean} [options.binary] Specifies whether `data` is binary or
       *     text
       * @param {Boolean} [options.compress] Specifies whether or not to compress
       *     `data`
       * @param {Boolean} [options.fin=true] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when data is written out
       * @public
       */
      send(data, options, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof options === "function") {
          cb = options;
          options = {};
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        const opts = {
          binary: typeof data !== "string",
          mask: !this._isServer,
          compress: true,
          fin: true,
          ...options
        };
        if (!this._extensions[PerMessageDeflate2.extensionName]) {
          opts.compress = false;
        }
        this._sender.send(data || EMPTY_BUFFER, opts, cb);
      }
      /**
       * Forcibly close the connection.
       *
       * @public
       */
      terminate() {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this._socket) {
          this._readyState = _WebSocket.CLOSING;
          this._socket.destroy();
        }
      }
    };
    Object.defineProperty(WebSocket2, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2.prototype, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2.prototype, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    [
      "binaryType",
      "bufferedAmount",
      "extensions",
      "isPaused",
      "protocol",
      "readyState",
      "url"
    ].forEach((property) => {
      Object.defineProperty(WebSocket2.prototype, property, { enumerable: true });
    });
    ["open", "error", "close", "message"].forEach((method) => {
      Object.defineProperty(WebSocket2.prototype, `on${method}`, {
        enumerable: true,
        get() {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) return listener[kListener];
          }
          return null;
        },
        set(handler) {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) {
              this.removeListener(method, listener);
              break;
            }
          }
          if (typeof handler !== "function") return;
          this.addEventListener(method, handler, {
            [kForOnEventAttribute]: true
          });
        }
      });
    });
    WebSocket2.prototype.addEventListener = addEventListener;
    WebSocket2.prototype.removeEventListener = removeEventListener;
    module.exports = WebSocket2;
    function initAsClient(websocket, address, protocols, options) {
      const opts = {
        allowSynchronousEvents: true,
        autoPong: true,
        closeTimeout: CLOSE_TIMEOUT,
        protocolVersion: protocolVersions[1],
        maxBufferedChunks: 1024 * 1024,
        maxFragments: 128 * 1024,
        maxPayload: 100 * 1024 * 1024,
        skipUTF8Validation: false,
        perMessageDeflate: true,
        followRedirects: false,
        maxRedirects: 10,
        ...options,
        socketPath: void 0,
        hostname: void 0,
        protocol: void 0,
        timeout: void 0,
        method: "GET",
        host: void 0,
        path: void 0,
        port: void 0
      };
      websocket._autoPong = opts.autoPong;
      websocket._closeTimeout = opts.closeTimeout;
      if (!protocolVersions.includes(opts.protocolVersion)) {
        throw new RangeError(
          `Unsupported protocol version: ${opts.protocolVersion} (supported versions: ${protocolVersions.join(", ")})`
        );
      }
      let parsedUrl;
      if (address instanceof URL) {
        parsedUrl = address;
      } else {
        try {
          parsedUrl = new URL(address);
        } catch {
          throw new SyntaxError(`Invalid URL: ${address}`);
        }
      }
      if (parsedUrl.protocol === "http:") {
        parsedUrl.protocol = "ws:";
      } else if (parsedUrl.protocol === "https:") {
        parsedUrl.protocol = "wss:";
      }
      websocket._url = parsedUrl.href;
      const isSecure = parsedUrl.protocol === "wss:";
      const isIpcUrl = parsedUrl.protocol === "ws+unix:";
      let invalidUrlMessage;
      if (parsedUrl.protocol !== "ws:" && !isSecure && !isIpcUrl) {
        invalidUrlMessage = `The URL's protocol must be one of "ws:", "wss:", "http:", "https:", or "ws+unix:"`;
      } else if (isIpcUrl && !parsedUrl.pathname) {
        invalidUrlMessage = "The URL's pathname is empty";
      } else if (parsedUrl.hash) {
        invalidUrlMessage = "The URL contains a fragment identifier";
      }
      if (invalidUrlMessage) {
        const err = new SyntaxError(invalidUrlMessage);
        if (websocket._redirects === 0) {
          throw err;
        } else {
          emitErrorAndClose(websocket, err);
          return;
        }
      }
      const defaultPort = isSecure ? 443 : 80;
      const key = randomBytes2(16).toString("base64");
      const request = isSecure ? https.request : http.request;
      const protocolSet = /* @__PURE__ */ new Set();
      let perMessageDeflate;
      opts.createConnection = opts.createConnection || (isSecure ? tlsConnect : netConnect);
      opts.defaultPort = opts.defaultPort || defaultPort;
      opts.port = parsedUrl.port || defaultPort;
      opts.host = parsedUrl.hostname.startsWith("[") ? parsedUrl.hostname.slice(1, -1) : parsedUrl.hostname;
      opts.headers = {
        ...opts.headers,
        "Sec-WebSocket-Version": opts.protocolVersion,
        "Sec-WebSocket-Key": key,
        Connection: "Upgrade",
        Upgrade: "websocket"
      };
      opts.path = parsedUrl.pathname + parsedUrl.search;
      opts.timeout = opts.handshakeTimeout;
      if (opts.perMessageDeflate) {
        perMessageDeflate = new PerMessageDeflate2({
          ...opts.perMessageDeflate,
          isServer: false,
          maxPayload: opts.maxPayload
        });
        opts.headers["Sec-WebSocket-Extensions"] = format({
          [PerMessageDeflate2.extensionName]: perMessageDeflate.offer()
        });
      }
      if (protocols.length) {
        for (const protocol of protocols) {
          if (typeof protocol !== "string" || !subprotocolRegex.test(protocol) || protocolSet.has(protocol)) {
            throw new SyntaxError(
              "An invalid or duplicated subprotocol was specified"
            );
          }
          protocolSet.add(protocol);
        }
        opts.headers["Sec-WebSocket-Protocol"] = protocols.join(",");
      }
      if (opts.origin) {
        if (opts.protocolVersion < 13) {
          opts.headers["Sec-WebSocket-Origin"] = opts.origin;
        } else {
          opts.headers.Origin = opts.origin;
        }
      }
      if (parsedUrl.username || parsedUrl.password) {
        opts.auth = `${parsedUrl.username}:${parsedUrl.password}`;
      }
      if (isIpcUrl) {
        const parts = opts.path.split(":");
        opts.socketPath = parts[0];
        opts.path = parts[1];
      }
      let req;
      if (opts.followRedirects) {
        if (websocket._redirects === 0) {
          websocket._originalIpc = isIpcUrl;
          websocket._originalSecure = isSecure;
          websocket._originalHostOrSocketPath = isIpcUrl ? opts.socketPath : parsedUrl.host;
          const headers = options && options.headers;
          options = { ...options, headers: {} };
          if (headers) {
            for (const [key2, value] of Object.entries(headers)) {
              options.headers[key2.toLowerCase()] = value;
            }
          }
        } else if (websocket.listenerCount("redirect") === 0) {
          const isSameHost = isIpcUrl ? websocket._originalIpc ? opts.socketPath === websocket._originalHostOrSocketPath : false : websocket._originalIpc ? false : parsedUrl.host === websocket._originalHostOrSocketPath;
          if (!isSameHost || websocket._originalSecure && !isSecure) {
            delete opts.headers.authorization;
            delete opts.headers.cookie;
            if (!isSameHost) delete opts.headers.host;
            opts.auth = void 0;
          }
        }
        if (opts.auth && !options.headers.authorization) {
          options.headers.authorization = "Basic " + Buffer.from(opts.auth).toString("base64");
        }
        req = websocket._req = request(opts);
        if (websocket._redirects) {
          websocket.emit("redirect", websocket.url, req);
        }
      } else {
        req = websocket._req = request(opts);
      }
      if (opts.timeout) {
        req.on("timeout", () => {
          abortHandshake(websocket, req, "Opening handshake has timed out");
        });
      }
      req.on("error", (err) => {
        if (req === null || req[kAborted]) return;
        req = websocket._req = null;
        emitErrorAndClose(websocket, err);
      });
      req.on("response", (res) => {
        const location = res.headers.location;
        const statusCode = res.statusCode;
        if (location && opts.followRedirects && statusCode >= 300 && statusCode < 400) {
          if (++websocket._redirects > opts.maxRedirects) {
            abortHandshake(websocket, req, "Maximum redirects exceeded");
            return;
          }
          req.abort();
          let addr;
          try {
            addr = new URL(location, address);
          } catch (e) {
            const err = new SyntaxError(`Invalid URL: ${location}`);
            emitErrorAndClose(websocket, err);
            return;
          }
          initAsClient(websocket, addr, protocols, options);
        } else if (!websocket.emit("unexpected-response", req, res)) {
          abortHandshake(
            websocket,
            req,
            `Unexpected server response: ${res.statusCode}`
          );
        }
      });
      req.on("upgrade", (res, socket, head) => {
        websocket.emit("upgrade", res);
        if (websocket.readyState !== WebSocket2.CONNECTING) return;
        req = websocket._req = null;
        const upgrade = res.headers.upgrade;
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          abortHandshake(websocket, socket, "Invalid Upgrade header");
          return;
        }
        const digest = createHash("sha1").update(key + GUID).digest("base64");
        if (res.headers["sec-websocket-accept"] !== digest) {
          abortHandshake(websocket, socket, "Invalid Sec-WebSocket-Accept header");
          return;
        }
        const serverProt = res.headers["sec-websocket-protocol"];
        let protError;
        if (serverProt !== void 0) {
          if (!protocolSet.size) {
            protError = "Server sent a subprotocol but none was requested";
          } else if (!protocolSet.has(serverProt)) {
            protError = "Server sent an invalid subprotocol";
          }
        } else if (protocolSet.size) {
          protError = "Server sent no subprotocol";
        }
        if (protError) {
          abortHandshake(websocket, socket, protError);
          return;
        }
        if (serverProt) websocket._protocol = serverProt;
        const secWebSocketExtensions = res.headers["sec-websocket-extensions"];
        if (secWebSocketExtensions !== void 0) {
          if (!perMessageDeflate) {
            const message = "Server sent a Sec-WebSocket-Extensions header but no extension was requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          let extensions;
          try {
            extensions = parse(secWebSocketExtensions);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          const extensionNames = Object.keys(extensions);
          if (extensionNames.length !== 1 || extensionNames[0] !== PerMessageDeflate2.extensionName) {
            const message = "Server indicated an extension that was not requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          try {
            perMessageDeflate.accept(extensions[PerMessageDeflate2.extensionName]);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          websocket._extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
        }
        websocket.setSocket(socket, head, {
          allowSynchronousEvents: opts.allowSynchronousEvents,
          generateMask: opts.generateMask,
          maxBufferedChunks: opts.maxBufferedChunks,
          maxFragments: opts.maxFragments,
          maxPayload: opts.maxPayload,
          skipUTF8Validation: opts.skipUTF8Validation
        });
      });
      if (opts.finishRequest) {
        opts.finishRequest(req, websocket);
      } else {
        req.end();
      }
    }
    function emitErrorAndClose(websocket, err) {
      websocket._readyState = WebSocket2.CLOSING;
      websocket._errorEmitted = true;
      websocket.emit("error", err);
      websocket.emitClose();
    }
    function netConnect(options) {
      options.path = options.socketPath;
      return net.connect(options);
    }
    function tlsConnect(options) {
      options.path = void 0;
      if (!options.servername && options.servername !== "") {
        options.servername = net.isIP(options.host) ? "" : options.host;
      }
      return tls.connect(options);
    }
    function abortHandshake(websocket, stream, message) {
      websocket._readyState = WebSocket2.CLOSING;
      const err = new Error(message);
      Error.captureStackTrace(err, abortHandshake);
      if (stream.setHeader) {
        stream[kAborted] = true;
        stream.abort();
        if (stream.socket && !stream.socket.destroyed) {
          stream.socket.destroy();
        }
        process.nextTick(emitErrorAndClose, websocket, err);
      } else {
        stream.destroy(err);
        stream.once("error", websocket.emit.bind(websocket, "error"));
        stream.once("close", websocket.emitClose.bind(websocket));
      }
    }
    function sendAfterClose(websocket, data, cb) {
      if (data) {
        const length = isBlob(data) ? data.size : toBuffer(data).length;
        if (websocket._socket) websocket._sender._bufferedBytes += length;
        else websocket._bufferedAmount += length;
      }
      if (cb) {
        const err = new Error(
          `WebSocket is not open: readyState ${websocket.readyState} (${readyStates[websocket.readyState]})`
        );
        process.nextTick(cb, err);
      }
    }
    function receiverOnConclude(code, reason) {
      const websocket = this[kWebSocket];
      websocket._closeFrameReceived = true;
      websocket._closeMessage = reason;
      websocket._closeCode = code;
      if (websocket._socket[kWebSocket] === void 0) return;
      websocket._socket.removeListener("data", socketOnData);
      process.nextTick(resume2, websocket._socket);
      if (code === 1005) websocket.close();
      else websocket.close(code, reason);
    }
    function receiverOnDrain() {
      const websocket = this[kWebSocket];
      if (!websocket.isPaused) websocket._socket.resume();
    }
    function receiverOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket._socket[kWebSocket] !== void 0) {
        websocket._socket.removeListener("data", socketOnData);
        process.nextTick(resume2, websocket._socket);
        websocket.close(err[kStatusCode]);
      }
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function receiverOnFinish() {
      this[kWebSocket].emitClose();
    }
    function receiverOnMessage(data, isBinary) {
      this[kWebSocket].emit("message", data, isBinary);
    }
    function receiverOnPing(data) {
      const websocket = this[kWebSocket];
      if (websocket._autoPong) websocket.pong(data, !this._isServer, NOOP);
      websocket.emit("ping", data);
    }
    function receiverOnPong(data) {
      this[kWebSocket].emit("pong", data);
    }
    function resume2(stream) {
      stream.resume();
    }
    function senderOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket.readyState === WebSocket2.CLOSED) return;
      if (websocket.readyState === WebSocket2.OPEN) {
        websocket._readyState = WebSocket2.CLOSING;
        setCloseTimer(websocket);
      }
      this._socket.end();
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function setCloseTimer(websocket) {
      websocket._closeTimer = setTimeout(
        websocket._socket.destroy.bind(websocket._socket),
        websocket._closeTimeout
      );
    }
    function socketOnClose() {
      const websocket = this[kWebSocket];
      this.removeListener("close", socketOnClose);
      this.removeListener("data", socketOnData);
      this.removeListener("end", socketOnEnd);
      websocket._readyState = WebSocket2.CLOSING;
      if (!this._readableState.endEmitted && !websocket._closeFrameReceived && !websocket._receiver._writableState.errorEmitted && this._readableState.length !== 0) {
        const chunk = this.read(this._readableState.length);
        websocket._receiver.write(chunk);
      }
      websocket._receiver.end();
      this[kWebSocket] = void 0;
      clearTimeout(websocket._closeTimer);
      if (websocket._receiver._writableState.finished || websocket._receiver._writableState.errorEmitted) {
        websocket.emitClose();
      } else {
        websocket._receiver.on("error", receiverOnFinish);
        websocket._receiver.on("finish", receiverOnFinish);
      }
    }
    function socketOnData(chunk) {
      if (!this[kWebSocket]._receiver.write(chunk)) {
        this.pause();
      }
    }
    function socketOnEnd() {
      const websocket = this[kWebSocket];
      websocket._readyState = WebSocket2.CLOSING;
      websocket._receiver.end();
      this.end();
    }
    function socketOnError() {
      const websocket = this[kWebSocket];
      this.removeListener("error", socketOnError);
      this.on("error", NOOP);
      if (websocket) {
        websocket._readyState = WebSocket2.CLOSING;
        this.destroy();
      }
    }
  }
});

// node_modules/ws/lib/stream.js
var require_stream = __commonJS({
  "node_modules/ws/lib/stream.js"(exports, module) {
    "use strict";
    var WebSocket2 = require_websocket();
    var { Duplex } = __require("stream");
    function emitClose(stream) {
      stream.emit("close");
    }
    function duplexOnEnd() {
      if (!this.destroyed && this._writableState.finished) {
        this.destroy();
      }
    }
    function duplexOnError(err) {
      this.removeListener("error", duplexOnError);
      this.destroy();
      if (this.listenerCount("error") === 0) {
        this.emit("error", err);
      }
    }
    function createWebSocketStream2(ws, options) {
      let terminateOnDestroy = true;
      const duplex = new Duplex({
        ...options,
        autoDestroy: false,
        emitClose: false,
        objectMode: false,
        writableObjectMode: false
      });
      ws.on("message", function message(msg, isBinary) {
        const data = !isBinary && duplex._readableState.objectMode ? msg.toString() : msg;
        if (!duplex.push(data)) ws.pause();
      });
      ws.once("error", function error(err) {
        if (duplex.destroyed) return;
        terminateOnDestroy = false;
        duplex.destroy(err);
      });
      ws.once("close", function close() {
        if (duplex.destroyed) return;
        duplex.push(null);
      });
      duplex._destroy = function(err, callback) {
        if (ws.readyState === ws.CLOSED) {
          callback(err);
          process.nextTick(emitClose, duplex);
          return;
        }
        let called = false;
        ws.once("error", function error(err2) {
          called = true;
          callback(err2);
        });
        ws.once("close", function close() {
          if (!called) callback(err);
          process.nextTick(emitClose, duplex);
        });
        if (terminateOnDestroy) ws.terminate();
      };
      duplex._final = function(callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._final(callback);
          });
          return;
        }
        if (ws._socket === null) return;
        if (ws._socket._writableState.finished) {
          callback();
          if (duplex._readableState.endEmitted) duplex.destroy();
        } else {
          ws._socket.once("finish", function finish() {
            callback();
          });
          ws.close();
        }
      };
      duplex._read = function() {
        if (ws.isPaused) ws.resume();
      };
      duplex._write = function(chunk, encoding, callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._write(chunk, encoding, callback);
          });
          return;
        }
        ws.send(chunk, callback);
      };
      duplex.on("end", duplexOnEnd);
      duplex.on("error", duplexOnError);
      return duplex;
    }
    module.exports = createWebSocketStream2;
  }
});

// node_modules/ws/lib/subprotocol.js
var require_subprotocol = __commonJS({
  "node_modules/ws/lib/subprotocol.js"(exports, module) {
    "use strict";
    var { tokenChars } = require_validation();
    function parse(header) {
      const protocols = /* @__PURE__ */ new Set();
      let start = -1;
      let end = -1;
      let i = 0;
      for (i; i < header.length; i++) {
        const code = header.charCodeAt(i);
        if (end === -1 && tokenChars[code] === 1) {
          if (start === -1) start = i;
        } else if (i !== 0 && (code === 32 || code === 9)) {
          if (end === -1 && start !== -1) end = i;
        } else if (code === 44) {
          if (start === -1) {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
          if (end === -1) end = i;
          const protocol2 = header.slice(start, end);
          if (protocols.has(protocol2)) {
            throw new SyntaxError(`The "${protocol2}" subprotocol is duplicated`);
          }
          protocols.add(protocol2);
          start = end = -1;
        } else {
          throw new SyntaxError(`Unexpected character at index ${i}`);
        }
      }
      if (start === -1 || end !== -1) {
        throw new SyntaxError("Unexpected end of input");
      }
      const protocol = header.slice(start, i);
      if (protocols.has(protocol)) {
        throw new SyntaxError(`The "${protocol}" subprotocol is duplicated`);
      }
      protocols.add(protocol);
      return protocols;
    }
    module.exports = { parse };
  }
});

// node_modules/ws/lib/websocket-server.js
var require_websocket_server = __commonJS({
  "node_modules/ws/lib/websocket-server.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events");
    var http = __require("http");
    var { Duplex } = __require("stream");
    var { createHash } = __require("crypto");
    var extension2 = require_extension();
    var PerMessageDeflate2 = require_permessage_deflate();
    var subprotocol2 = require_subprotocol();
    var WebSocket2 = require_websocket();
    var { CLOSE_TIMEOUT, GUID, kWebSocket } = require_constants();
    var keyRegex = /^[+/0-9A-Za-z]{22}==$/;
    var RUNNING = 0;
    var CLOSING = 1;
    var CLOSED = 2;
    var WebSocketServer2 = class extends EventEmitter {
      /**
       * Create a `WebSocketServer` instance.
       *
       * @param {Object} options Configuration options
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Boolean} [options.autoPong=true] Specifies whether or not to
       *     automatically send a pong in response to a ping
       * @param {Number} [options.backlog=511] The maximum length of the queue of
       *     pending connections
       * @param {Boolean} [options.clientTracking=true] Specifies whether or not to
       *     track clients
       * @param {Number} [options.closeTimeout=30000] Duration in milliseconds to
       *     wait for the closing handshake to finish after `websocket.close()` is
       *     called
       * @param {Function} [options.handleProtocols] A hook to handle protocols
       * @param {String} [options.host] The hostname where to bind the server
       * @param {Number} [options.maxBufferedChunks=1048576] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=131072] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=104857600] The maximum allowed message
       *     size
       * @param {Boolean} [options.noServer=false] Enable no server mode
       * @param {String} [options.path] Accept only connections matching this path
       * @param {(Boolean|Object)} [options.perMessageDeflate=false] Enable/disable
       *     permessage-deflate
       * @param {Number} [options.port] The port where to bind the server
       * @param {(http.Server|https.Server)} [options.server] A pre-created HTTP/S
       *     server to use
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @param {Function} [options.verifyClient] A hook to reject connections
       * @param {Function} [options.WebSocket=WebSocket] Specifies the `WebSocket`
       *     class to use. It must be the `WebSocket` class or class that extends it
       * @param {Function} [callback] A listener for the `listening` event
       */
      constructor(options, callback) {
        super();
        options = {
          allowSynchronousEvents: true,
          autoPong: true,
          maxBufferedChunks: 1024 * 1024,
          maxFragments: 128 * 1024,
          maxPayload: 100 * 1024 * 1024,
          skipUTF8Validation: false,
          perMessageDeflate: false,
          handleProtocols: null,
          clientTracking: true,
          closeTimeout: CLOSE_TIMEOUT,
          verifyClient: null,
          noServer: false,
          backlog: null,
          // use default (511 as implemented in net.js)
          server: null,
          host: null,
          path: null,
          port: null,
          WebSocket: WebSocket2,
          ...options
        };
        if (options.port == null && !options.server && !options.noServer || options.port != null && (options.server || options.noServer) || options.server && options.noServer) {
          throw new TypeError(
            'One and only one of the "port", "server", or "noServer" options must be specified'
          );
        }
        if (options.port != null) {
          this._server = http.createServer((req, res) => {
            const body = http.STATUS_CODES[426];
            res.writeHead(426, {
              "Content-Length": body.length,
              "Content-Type": "text/plain"
            });
            res.end(body);
          });
          this._server.listen(
            options.port,
            options.host,
            options.backlog,
            callback
          );
        } else if (options.server) {
          this._server = options.server;
        }
        if (this._server) {
          const emitConnection = this.emit.bind(this, "connection");
          this._removeListeners = addListeners(this._server, {
            listening: this.emit.bind(this, "listening"),
            error: this.emit.bind(this, "error"),
            upgrade: (req, socket, head) => {
              this.handleUpgrade(req, socket, head, emitConnection);
            }
          });
        }
        if (options.perMessageDeflate === true) options.perMessageDeflate = {};
        if (options.clientTracking) {
          this.clients = /* @__PURE__ */ new Set();
          this._shouldEmitClose = false;
        }
        this.options = options;
        this._state = RUNNING;
      }
      /**
       * Returns the bound address, the address family name, and port of the server
       * as reported by the operating system if listening on an IP socket.
       * If the server is listening on a pipe or UNIX domain socket, the name is
       * returned as a string.
       *
       * @return {(Object|String|null)} The address of the server
       * @public
       */
      address() {
        if (this.options.noServer) {
          throw new Error('The server is operating in "noServer" mode');
        }
        if (!this._server) return null;
        return this._server.address();
      }
      /**
       * Stop the server from accepting new connections and emit the `'close'` event
       * when all existing connections are closed.
       *
       * @param {Function} [cb] A one-time listener for the `'close'` event
       * @public
       */
      close(cb) {
        if (this._state === CLOSED) {
          if (cb) {
            this.once("close", () => {
              cb(new Error("The server is not running"));
            });
          }
          process.nextTick(emitClose, this);
          return;
        }
        if (cb) this.once("close", cb);
        if (this._state === CLOSING) return;
        this._state = CLOSING;
        if (this.options.noServer || this.options.server) {
          if (this._server) {
            this._removeListeners();
            this._removeListeners = this._server = null;
          }
          if (this.clients) {
            if (!this.clients.size) {
              process.nextTick(emitClose, this);
            } else {
              this._shouldEmitClose = true;
            }
          } else {
            process.nextTick(emitClose, this);
          }
        } else {
          const server = this._server;
          this._removeListeners();
          this._removeListeners = this._server = null;
          server.close(() => {
            emitClose(this);
          });
        }
      }
      /**
       * See if a given request should be handled by this server instance.
       *
       * @param {http.IncomingMessage} req Request object to inspect
       * @return {Boolean} `true` if the request is valid, else `false`
       * @public
       */
      shouldHandle(req) {
        if (this.options.path) {
          const index = req.url.indexOf("?");
          const pathname = index !== -1 ? req.url.slice(0, index) : req.url;
          if (pathname !== this.options.path) return false;
        }
        return true;
      }
      /**
       * Handle a HTTP Upgrade request.
       *
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @public
       */
      handleUpgrade(req, socket, head, cb) {
        socket.on("error", socketOnError);
        const key = req.headers["sec-websocket-key"];
        const upgrade = req.headers.upgrade;
        const version = +req.headers["sec-websocket-version"];
        if (req.method !== "GET") {
          const message = "Invalid HTTP method";
          abortHandshakeOrEmitwsClientError(this, req, socket, 405, message);
          return;
        }
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          const message = "Invalid Upgrade header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (key === void 0 || !keyRegex.test(key)) {
          const message = "Missing or invalid Sec-WebSocket-Key header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (version !== 13 && version !== 8) {
          const message = "Missing or invalid Sec-WebSocket-Version header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message, {
            "Sec-WebSocket-Version": "13, 8"
          });
          return;
        }
        if (!this.shouldHandle(req)) {
          abortHandshake(socket, 400);
          return;
        }
        const secWebSocketProtocol = req.headers["sec-websocket-protocol"];
        let protocols = /* @__PURE__ */ new Set();
        if (secWebSocketProtocol !== void 0) {
          try {
            protocols = subprotocol2.parse(secWebSocketProtocol);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Protocol header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        const secWebSocketExtensions = req.headers["sec-websocket-extensions"];
        const extensions = {};
        if (this.options.perMessageDeflate && secWebSocketExtensions !== void 0) {
          const perMessageDeflate = new PerMessageDeflate2({
            ...this.options.perMessageDeflate,
            isServer: true,
            maxPayload: this.options.maxPayload
          });
          try {
            const offers = extension2.parse(secWebSocketExtensions);
            if (offers[PerMessageDeflate2.extensionName]) {
              perMessageDeflate.accept(offers[PerMessageDeflate2.extensionName]);
              extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
            }
          } catch (err) {
            const message = "Invalid or unacceptable Sec-WebSocket-Extensions header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        if (this.options.verifyClient) {
          const info = {
            origin: req.headers[`${version === 8 ? "sec-websocket-origin" : "origin"}`],
            secure: !!(req.socket.authorized || req.socket.encrypted),
            req
          };
          if (this.options.verifyClient.length === 2) {
            this.options.verifyClient(info, (verified, code, message, headers) => {
              if (!verified) {
                return abortHandshake(socket, code || 401, message, headers);
              }
              this.completeUpgrade(
                extensions,
                key,
                protocols,
                req,
                socket,
                head,
                cb
              );
            });
            return;
          }
          if (!this.options.verifyClient(info)) return abortHandshake(socket, 401);
        }
        this.completeUpgrade(extensions, key, protocols, req, socket, head, cb);
      }
      /**
       * Upgrade the connection to WebSocket.
       *
       * @param {Object} extensions The accepted extensions
       * @param {String} key The value of the `Sec-WebSocket-Key` header
       * @param {Set} protocols The subprotocols
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @throws {Error} If called more than once with the same socket
       * @private
       */
      completeUpgrade(extensions, key, protocols, req, socket, head, cb) {
        if (!socket.readable || !socket.writable) return socket.destroy();
        if (socket[kWebSocket]) {
          throw new Error(
            "server.handleUpgrade() was called more than once with the same socket, possibly due to a misconfiguration"
          );
        }
        if (this._state > RUNNING) return abortHandshake(socket, 503);
        const digest = createHash("sha1").update(key + GUID).digest("base64");
        const headers = [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${digest}`
        ];
        const ws = new this.options.WebSocket(null, void 0, this.options);
        if (protocols.size) {
          const protocol = this.options.handleProtocols ? this.options.handleProtocols(protocols, req) : protocols.values().next().value;
          if (protocol) {
            headers.push(`Sec-WebSocket-Protocol: ${protocol}`);
            ws._protocol = protocol;
          }
        }
        if (extensions[PerMessageDeflate2.extensionName]) {
          const params = extensions[PerMessageDeflate2.extensionName].params;
          const value = extension2.format({
            [PerMessageDeflate2.extensionName]: [params]
          });
          headers.push(`Sec-WebSocket-Extensions: ${value}`);
          ws._extensions = extensions;
        }
        this.emit("headers", headers, req);
        socket.write(headers.concat("\r\n").join("\r\n"));
        socket.removeListener("error", socketOnError);
        ws.setSocket(socket, head, {
          allowSynchronousEvents: this.options.allowSynchronousEvents,
          maxBufferedChunks: this.options.maxBufferedChunks,
          maxFragments: this.options.maxFragments,
          maxPayload: this.options.maxPayload,
          skipUTF8Validation: this.options.skipUTF8Validation
        });
        if (this.clients) {
          this.clients.add(ws);
          ws.on("close", () => {
            this.clients.delete(ws);
            if (this._shouldEmitClose && !this.clients.size) {
              process.nextTick(emitClose, this);
            }
          });
        }
        cb(ws, req);
      }
    };
    module.exports = WebSocketServer2;
    function addListeners(server, map) {
      for (const event of Object.keys(map)) server.on(event, map[event]);
      return function removeListeners() {
        for (const event of Object.keys(map)) {
          server.removeListener(event, map[event]);
        }
      };
    }
    function emitClose(server) {
      server._state = CLOSED;
      server.emit("close");
    }
    function socketOnError() {
      this.destroy();
    }
    function abortHandshake(socket, code, message, headers) {
      message = message || http.STATUS_CODES[code];
      headers = {
        Connection: "close",
        "Content-Type": "text/html",
        "Content-Length": Buffer.byteLength(message),
        ...headers
      };
      socket.once("finish", socket.destroy);
      socket.end(
        `HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r
` + Object.keys(headers).map((h) => `${h}: ${headers[h]}`).join("\r\n") + "\r\n\r\n" + message
      );
    }
    function abortHandshakeOrEmitwsClientError(server, req, socket, code, message, headers) {
      if (server.listenerCount("wsClientError")) {
        const err = new Error(message);
        Error.captureStackTrace(err, abortHandshakeOrEmitwsClientError);
        server.emit("wsClientError", err, socket, req);
      } else {
        abortHandshake(socket, code, message, headers);
      }
    }
  }
});

// src/proc.ts
import { spawn } from "node:child_process";
function spawnCapture(argv, options) {
  return new Promise((resolve, reject) => {
    const [command, ...args] = argv;
    if (command === void 0) {
      reject(new Error("spawnCapture: empty argument vector"));
      return;
    }
    const child = spawn(command, args, {
      // `pipe` on all three streams, so `child.stdin/stdout/stderr` are the
      // non-null streams the capture below relies on.
      stdio: ["pipe", "pipe", "pipe"],
      env: options?.env ?? process.env,
      cwd: options?.cwd
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
    child.stdin.on("error", () => {
    });
    child.stdin.end(options?.stdin ?? "");
  });
}

// src/column.ts
var runColumn = (input) => spawnCapture(["column", "-t", "-s", "	"], { stdin: input });

// src/grep.ts
var runGrep = async (pattern, input) => {
  const { code } = await spawnCapture(["grep", "-qE", pattern], { stdin: input });
  return code;
};

// src/help.ts
var OVERVIEW_HELP = `tm \u2014 tmux teammate manager for the dispatcher skill

Run \`tm <verb> --help\` (or \`tm help <verb>\`) for per-verb detail.

USAGE  (most common first)
  tm send <repo> --prompt "..."          atomic round-trip: send + wait + print reply
  tm spawn <repo> [--prompt "..."]       launch teammate; --prompt = atomic bootstrap
  tm wait <repo> [--fresh]               wait for next Stop; print reply
  tm compact <repo>                      /compact + verify, prints "compacted"
  tm resume <repo> [<sid>]               resume a prior conversation
  tm last <repo>                         reprint the last-turn reply
  tm kill <repo>                         kill the teammate's tmux session
  tm reload <repo>... | --all            fan out /reload-plugins
  tm ls                                  list running teammate sessions
  tm states                              one-line fleet snapshot
  tm ctx <repo>... | --all               real ctx-window usage from jsonl
  tm history <repo> [<sid-prefix>]       inspect past sessions for this repo
  tm mem <repo>                          cat sibling repo's auto-memory index
  tm archive <id>                        move finished task active\u2192archive (stdin)
  tm ask "<prompt>"                      one-shot turn on an idle codex teammate (pool)

DIAGNOSTIC (escape hatches \u2014 prefer the verbs above)
  tm status <repo>                       capture-pane the teammate's live screen
  tm poll <repo> <regex>                 block until pane matches
  tm doctor                              self-check: tm path/version, env, tmux,
                                         idle dir, active teammates

HELP
  tm --help / tm -h / tm help            this text
  tm <verb> --help / tm help <verb>      detail for one verb

ENVIRONMENT
  TM_DISPATCHER_DIR    Dispatcher directory (parent of sibling repos).
                       scripts/setup.sh writes it into the dispatcher's
                       .claude/settings.json on first /claudemux:setup,
                       and Claude Code injects it as env at every
                       claude launch \u2014 so tm stays correct even when
                       the Bash tool's cwd drifts. Falls back to $PWD
                       when unset (backward compat for dispatchers set
                       up before this feature).
`;
var HELP_TEXTS = {
  ls: `tm ls

      List running teammate-<repo> sessions. Shows tmux's raw session
      row (name, window count, attached state). For a richer "who's
      doing what" view, prefer \`tm states\`.
`,
  states: `tm states

      One-line fleet snapshot: REPO, SID (first 8 chars), BUSY (yes
      if the .busy file from the on-busy hook is present), LAST
      (size + age of <sid>.last), PREVIEW (first 50 chars of last
      reply). Use to see what every teammate is doing at a glance.
`,
  spawn: `tm spawn <repo> [--task <slug>] [--prompt "..."] [--no-wait]

      Launch a claude teammate in <dispatcher-dir>/<repo>, where the
      dispatcher dir comes from TM_DISPATCHER_DIR (or $PWD fallback);
      fails with "repo not found" if <repo> isn't a direct
      subdirectory of it.
      Without --prompt, returns once the REPL signals SessionStart
      (typically 2-4s on a warm Mac). With --prompt "...", sleeps 3s
      after ready, sends the prompt, waits for Stop, and prints the
      teammate's first-turn reply on stdout \u2014 atomic bootstrap, one
      call. --no-wait combined with --prompt sends without waiting.
      --task <slug> names the conversation <repo>-<slug>. Allowlist:
      ASCII letters/digits + CJK Unified Ideographs (\u4E2D\u65E5\u97E9\u6C49\u5B57).
      Without --task a fresh spawn auto-names <repo>-<rand4>.
      Fresh spawns also write an empty /tmp/claude-idle/<sid>.last
      sentinel, so 'tm last' before any reply returns a clear "no
      reply yet" error instead of stale content from an earlier sid.
      The --prompt sync path inherits 'tm send''s stderr ctx echo
      after the first-turn Stop.
      Every teammate launches with the AskUserQuestion tool disabled
      (this applies to 'tm resume' too). A teammate runs with no
      human at its terminal, and that tool's modal holds the turn
      open so the Stop hook never fires \u2014 a sync verb would then
      block until --timeout. With the tool gone, a teammate raises
      questions by ending its turn with text, which 'tm send' /
      'tm spawn --prompt' relays straight back to the dispatcher.
`,
  send: `tm send <repo> --prompt "..." [--no-wait] [--pane-quiet] [--timeout N]

      Atomic round-trip by default: send prompt + wait for the Stop
      hook + print the teammate's reply text on stdout. The
      dispatcher's primary verb \u2014 folds what used to be send +
      wait-idle + last into one call. Stdout is exclusively reply
      text; status lines go to stderr (pipe-friendly).
      --prompt "..." the prompt text. Required. Same calling form
        as 'tm spawn --prompt' / 'tm resume --prompt'. Flag order is
        free: 'tm send <repo> --prompt "..."' and 'tm send --prompt
        "..." <repo>' both work.
      --no-wait fire-and-forget; return as soon as the keys are
        sent. Use for /clear before kill, or any case where the
        reply doesn't matter. (--pane-quiet has no effect with
        --no-wait, since nothing waits.)
      --pane-quiet falls back to pane-quiet detection. Use for
        TUI-only commands that fire no hook: /help, /effort,
        /agents, permission prompts. /compact and /clear do NOT
        need it \u2014 the Stop hook now covers them via PostCompact /
        SessionEnd.
      --timeout N overrides the 1800s default wait.
      Empty stdout never silently means success: a turn with no text
      (tool-only, /compact, /clear) prints the sentinel line "(no
      text reply this turn \u2014 tool-only, /compact, /clear, or fresh
      spawn)".
      On the default (Stop-hook) path, also echoes the teammate's
      post-turn ctx to stderr as "ctx: N tokens \xB7 ~M next turn \xB7 X%
      of W (note)" \u2014 same data as 'tm ctx <repo>' inline with the
      reply. Skipped on --pane-quiet (no fresh usage block in jsonl)
      and --no-wait (nothing waited).
      On timeout: stderr warning, partial .last to stdout if any,
      exit 1.

      When <repo> is a codex teammate (name starts with 'codex-'),
      this verb routes into the codex driver instead: only --prompt
      and --no-wait are accepted, the reply on stdout is the raw
      Turn JSON, and --no-wait composes with 'tm wait codex-<n>' for
      the async case. Tmux-bound flags (--pane-quiet, --timeout) are
      rejected explicitly rather than silently ignored.
`,
  wait: `tm wait <repo> [timeout=1800] [--fresh] [--pane-quiet] [--timeout N]

      Block until the teammate's next Stop hook (or pane-quiet
      fallback), then print the reply to stdout \u2014 same output
      contract as 'tm send'. Use when an external actor (Remote
      Control web UI, mobile app, cron) drove the turn and you just
      want to collect the result.
      --fresh clears the idle/.last/.busy baseline up front so the
        NEXT Stop unblocks the wait, not a prior one. Required when
        monitoring an autonomously progressing teammate (no fresh
        'tm send' to reset the baseline for you). No-op under
        --pane-quiet (pane-quiet uses send-at timing instead of a
        sid-keyed marker; the "\u22653s since last send" gate already
        provides the freshness guarantee).
      --pane-quiet falls back to pane-quiet detection (same use
        case as on 'tm send').
      --timeout N is the flag form of the positional [timeout=1800];
        both forms are accepted, and if both are passed, whichever
        is parsed last wins.
      Stop-hook path also echoes ctx to stderr (see 'tm send');
      skipped on --pane-quiet.
`,
  compact: `tm compact <repo> [timeout=1800] [--timeout N]

      Send /compact and verify PostCompact fired. Prints "compacted"
      on stdout when the Stop-hook idle marker is touched. Doesn't
      read ctx \u2014 run 'tm ctx <repo>' separately if you want the new
      size.
      Default timeout is 1800s \u2014 large contexts can run many
      minutes, and the cap only fires when compaction never
      finishes.
      Two non-success modes, both exit 1:
        - Claude Code refuses with "Not enough messages to compact"
          (transcript too short). That error fires no hook, so the
          pane is scanned alongside the idle-marker poll to detect
          it.
        - PostCompact never fires within timeout. Compaction is
          hung or the Stop hook is misconfigured.
`,
  resume: `tm resume <repo> [<sid>] [--task <slug>] [--prompt "..."] [--no-wait]

      Resume a prior conversation. PREFER passing <sid> from the
      dispatcher's task ledger (active-dispatcher-tasks.md records
      the sid of each teammate it spawned). Without sid, picks the
      newest jsonl by mtime as a one-off convenience (stderr
      warning). Validates the jsonl exists in the project dir; UUID
      format enforced. Fails if a teammate session for <repo>
      already exists.
      --prompt sends a follow-up after a 3s settle, atomic like
      'tm spawn --prompt' (inherits 'tm send''s stderr ctx echo on
      the sync path). --no-wait (with --prompt) fires without
      waiting. --task relabels the resumed conversation.
      Like every teammate launch, the resumed REPL starts with the
      AskUserQuestion tool disabled (see 'tm help spawn' for why): a
      resumed teammate raises questions by ending its turn with
      text, not by opening a modal.
`,
  last: `tm last <repo>

      Print the teammate's last-turn reply from
      /tmp/claude-idle/<sid>.last. Empty or missing file dies with
      "no reply yet". Use this when you want to re-read a reply the
      send/wait verbs already printed (their output is one-shot).
`,
  mem: `tm mem <repo>

      Cat the sibling repo's auto-memory MEMORY.md to stdout. Use
      this before composing a \`tm spawn\` / \`tm send --prompt\` that
      references sibling state (feature-gate names, branch names,
      in-progress projects) \u2014 sibling memories live in separate
      per-cwd index files that the dispatcher's own AutoMemory does
      not include. Resolves the encoded project dir as
      $HOME/.claude/projects/<encoded>/memory/MEMORY.md where
      <encoded> = the repo's physical cwd with every \`/\` and \`.\`
      replaced by \`-\`. If no MEMORY.md exists for the repo (never
      ran claude, or its project dir was pruned), prints a one-line
      notice to stderr and returns 0 with empty stdout \u2014 that is
      the normal "no sibling memory" case, not an error.

      MEMORY.md entries can be stale. Verify any fact you are about
      to inject into a teammate's prompt against current code or
      git state before sending.
`,
  kill: `tm kill <repo>

      Kill the teammate's tmux session and clean up its state files
      (/tmp/teammate-<repo>.{sid,send-at,ready,cwd}). A codex-<n>
      target reaps the codex daemon and its registry directory instead.
`,
  ask: `tm ask "<prompt>"

      Drive a one-shot turn on an idle codex teammate from the
      \`codex-<n>\` pool, on a fresh thread (so the borrowed teammate's
      persistent conversation thread is not polluted). Prints the
      turn's JSON to stdout.

      Pool semantics (decision 0019 \xA76, pool decision A): the named
      \`codex-<n>\` teammates are the pool. ask picks any idle one,
      borrows it for one turn, and returns it. "Idle" means it has no
      active borrow lock; the lock is a file under
      /tmp/teammate-codex/<name>/lock.

      Errors when no codex teammate has been spawned, when every
      spawned teammate is dead (run 'tm doctor' to reap), or when
      every alive teammate is currently borrowed (retry, or spawn one
      more).
`,
  reload: `tm reload <repo>... | --all

      Fan out /reload-plugins to one, many, or every teammate.
      Sugar over 'tm send <repo> --prompt /reload-plugins'. --all enumerates
      from \`tmux ls\`; missing/dead teammates are skipped with a
      stderr note and the exit status reflects whether every send
      succeeded.
`,
  ctx: `tm ctx <repo>... | --all [--window 200k|1m]

      Real context-window usage per teammate, read from the jsonl
      usage block (more accurate than the TUI percentage). Prints
      current prompt size, next-turn estimate, and percent of
      window.
      Window size is not in the transcript: a peak above ~210k
      proves a 1M window; otherwise 200k is assumed (labelled
      accordingly). --window forces the assumption.
`,
  history: `tm history <repo> [<sid-or-prefix>]

      Inspect this repo's past Claude sessions (live or dead). No
      <sid>: list mode, newest-first table (SID, AGE, SIZE, TOPIC =
      first user prompt). '*' marks the current live teammate's
      session. With <sid> or 8+ char prefix: detail mode (full sid,
      file path, created/last-seen, ctx usage, first prompt, last
      assistant text up to 1500 chars, ready-to-paste 'tm resume'
      command). Boundary vs 'tm last': last covers only the current
      live teammate's reply; history covers any jsonl on disk
      including killed sessions.
`,
  archive: `tm archive <id> [--status '<tag>']

      Move a finished task from the active ledger to the archive.
      Reads the compressed one/two-line outcome on stdin; copies
      repo/branch/intent verbatim from the active entry and stamps
      today's date. Prepends to dispatcher-tasks-archive.md (newest
      on top), creating it from its shape if absent, then deletes
      the entry from active-dispatcher-tasks.md. --status overrides
      the carried-over [status] tag.
`,
  status: `tm status <repo> [lines=80]

      Capture-pane the teammate's live screen. DIAGNOSTIC \u2014 the
      sync send/wait verbs make this unnecessary for normal flow.
      Reach for it only when you genuinely need the live pane (e.g.
      confirming a TUI dialog is up).
`,
  poll: `tm poll <repo> <regex> [timeout=180]

      Block until pane content matches a regex. DIAGNOSTIC fallback
      when \`tm wait\` can't catch an interesting intermediate state.
      Match the EXPECTED RESULT, not the prompt you just sent (a
      pattern that appears in the sent prompt makes the wait return
      instantly).
`,
  doctor: `tm doctor

      Self-check for the dispatcher environment. Reports, in order:
        - tm executable: resolved path and reported plugin version
        - dispatcher dir: TM_DISPATCHER_DIR (or $PWD fallback),
          whether the env was actually set, and whether the
          resolved path matches your current $PWD
        - tmux: installed? version? server running? are we inside
          a tmux session?
        - idle dir: does /tmp/claude-idle/ exist?
        - active teammates: count + names from \`tm ls\`
      Read-only \u2014 doesn't change any state. Use it when something
      looks off ("why is tm using the wrong path?" / "did
      /claudemux:setup actually write the env?"). Exit code is
      always 0; interpret the printed lines, not the status.
`
};
var REMOVED_VERB_MESSAGES = {
  // `tm ask` was removed in 0.3.0 and re-introduced in stage 4 with new
  // semantics (codex-mode borrow/return on a `codex-<n>` teammate). The
  // entry is therefore intentionally absent here — `cli.ts` routes the
  // verb into the native dispatch table instead.
  "wait-idle": `tm wait-idle was renamed to 'tm wait' in 0.3.0. Same semantics; the new verb also prints .last on stdout by default.
`,
  "wait-quiet": `tm wait-quiet was folded into the --pane-quiet flag in 0.3.0. Use 'tm wait <repo> --pane-quiet' (or 'tm send <repo> --prompt "..." --pane-quiet' for the send-then-wait composition).
`
};

// src/native.ts
import {
  existsSync as existsSync2,
  mkdirSync as mkdirSync2,
  readdirSync as readdirSync2,
  readFileSync as readFileSync3,
  realpathSync,
  rmSync as rmSync3,
  statSync as statSync2,
  writeFileSync as writeFileSync2
} from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join as join3 } from "node:path";

// src/paths.ts
import { join } from "node:path";
function idleDir() {
  return "/tmp/claude-idle";
}
function idleMarkerFor(sid) {
  return join(idleDir(), sid);
}
function busyMarkerFor(sid) {
  return join(idleDir(), `${sid}.busy`);
}
function lastFileFor(sid) {
  return join(idleDir(), `${sid}.last`);
}
function sidFile(repo) {
  return `/tmp/teammate-${repo}.sid`;
}
function cwdFile(repo) {
  return `/tmp/teammate-${repo}.cwd`;
}
function sendAtFile(repo) {
  return `/tmp/teammate-${repo}.send-at`;
}
function readyFile(repo) {
  return `/tmp/teammate-${repo}.ready`;
}
function encodeProjectDir(cwd) {
  return cwd.replace(/[^A-Za-z0-9-]/g, "-");
}
function codexRegistryRoot() {
  return process.env["CLAUDEMUX_CODEX_REGISTRY_ROOT"] || "/tmp/teammate-codex";
}
function codexTeammateDir(name) {
  return join(codexRegistryRoot(), name);
}
function codexSocketPath(name) {
  return join(codexTeammateDir(name), "socket");
}
function codexPidFile(name) {
  return join(codexTeammateDir(name), "pid");
}
function codexStartedAtFile(name) {
  return join(codexTeammateDir(name), "started-at");
}
function codexThreadFile(name) {
  return join(codexTeammateDir(name), "thread");
}
function codexLastSeenFile(name) {
  return join(codexTeammateDir(name), "last-seen");
}
function codexMetaFile(name) {
  return join(codexTeammateDir(name), "meta.json");
}

// src/codex-verbs.ts
import { closeSync as closeSync2, openSync as openSync2, readFileSync as readFileSync2, rmSync as rmSync2, writeSync as writeSync2 } from "node:fs";
import { join as join2 } from "node:path";

// node_modules/ws/wrapper.mjs
var import_stream = __toESM(require_stream(), 1);
var import_extension = __toESM(require_extension(), 1);
var import_permessage_deflate = __toESM(require_permessage_deflate(), 1);
var import_receiver = __toESM(require_receiver(), 1);
var import_sender = __toESM(require_sender(), 1);
var import_subprotocol = __toESM(require_subprotocol(), 1);
var import_websocket = __toESM(require_websocket(), 1);
var import_websocket_server = __toESM(require_websocket_server(), 1);
var wrapper_default = import_websocket.default;

// src/codex-ws.ts
var CodexWsClient = class {
  ws;
  pending = /* @__PURE__ */ new Map();
  notifHandlers = [];
  serverReqHandler = async () => null;
  nextId = 1;
  opened;
  closed = false;
  closeReason = null;
  constructor(opts) {
    if (opts.socketPath !== void 0) {
      this.ws = new wrapper_default(`ws+unix://${opts.socketPath}`);
    } else if (opts.url !== void 0) {
      this.ws = new wrapper_default(opts.url);
    } else {
      throw new Error("CodexWsClient: socketPath or url required");
    }
    this.opened = new Promise((res, rej) => {
      this.ws.once("open", () => res());
      this.ws.once("error", (e) => rej(e instanceof Error ? e : new Error(String(e))));
    });
    this.ws.on("message", (data) => this.onFrame(data));
    this.ws.on(
      "close",
      () => this.tearDown(new Error("codex daemon closed the connection"))
    );
    this.ws.on(
      "error",
      (e) => this.tearDown(e instanceof Error ? e : new Error(String(e)))
    );
  }
  /** Resolve once the WebSocket open handshake completes. */
  ready() {
    return this.opened;
  }
  /** Subscribe to a server-pushed notification stream — `turn/completed`, etc. */
  onNotification(handler) {
    this.notifHandlers.push(handler);
  }
  /**
   * Install the handler for server→client requests. The daemon issues these
   * when it wants the client to confirm a tool call, supply user input, or
   * generate an attestation; an `approval_policy: Never` codex teammate
   * largely suppresses them but cannot eliminate every one. The handler's
   * return value becomes the response envelope's `result`; a throw becomes
   * the response envelope's `error.message`.
   *
   * Without an explicit handler the daemon's request resolves to `null`,
   * which keeps the teammate from blocking but is rarely the right answer
   * for anything substantive. Set one before driving real turns.
   */
  setServerRequestHandler(handler) {
    this.serverReqHandler = handler;
  }
  /**
   * Send a client request and wait for the matching response envelope. The
   * caller passes the response type as the second generic so the return is
   * typed — codex's generated bindings do not emit a top-level response
   * union, so the client takes the expected `R` as a hint rather than
   * inferring it.
   */
  request(method, params) {
    if (this.closed) {
      return Promise.reject(this.closeReason ?? new Error("codex client closed"));
    }
    const id = this.nextId++;
    const envelope = { method, id, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject
      });
      try {
        this.ws.send(JSON.stringify(envelope));
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }
  /** Tear down. Pending requests reject with the caller's reason. */
  close() {
    this.tearDown(new Error("codex client closed by caller"));
    this.ws.close();
  }
  onFrame(data) {
    let parsed;
    try {
      const text = typeof data === "string" ? data : data.toString("utf8");
      parsed = JSON.parse(text);
    } catch (e) {
      this.tearDown(
        new Error(
          `codex daemon sent a non-JSON frame: ${e.message}`
        )
      );
      return;
    }
    if (typeof parsed !== "object" || parsed === null) {
      this.tearDown(
        new Error("codex daemon sent a non-object envelope")
      );
      return;
    }
    const env = parsed;
    const hasMethod = typeof env["method"] === "string";
    const hasId = typeof env["id"] === "number";
    const hasResult = "result" in env;
    const hasError = "error" in env;
    if (hasMethod && hasId) {
      this.handleServerRequest(env).catch(
        (err) => this.tearDown(
          err instanceof Error ? err : new Error(String(err))
        )
      );
    } else if (hasMethod) {
      this.dispatchNotification(env);
    } else if (hasId && (hasResult || hasError)) {
      this.handleResponse(env);
    } else {
      this.tearDown(
        new Error("codex daemon sent envelope with neither id nor method")
      );
    }
  }
  handleResponse(env) {
    const pending = this.pending.get(env.id);
    if (pending === void 0) return;
    this.pending.delete(env.id);
    if ("error" in env) {
      pending.reject(new Error(env.error.message));
    } else {
      pending.resolve(env.result);
    }
  }
  dispatchNotification(notif) {
    for (const h of this.notifHandlers) {
      try {
        h(notif);
      } catch {
      }
    }
  }
  async handleServerRequest(env) {
    const req = env;
    try {
      const result = await this.serverReqHandler(req);
      const reply = { id: env.id, result };
      this.ws.send(JSON.stringify(reply));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const reply = { id: env.id, error: { message } };
      this.ws.send(JSON.stringify(reply));
    }
  }
  tearDown(reason) {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const { reject } of this.pending.values()) reject(reason);
    this.pending.clear();
  }
};

// src/codex-supervisor.ts
import {
  spawn as spawnChild
} from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync
} from "node:fs";
function atomicWrite(path, content) {
  const tmpPath = `${path}.tmp`;
  const fd = openSync(tmpPath, "w", 384);
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, path);
}
function readIntFile(path) {
  try {
    const txt = readFileSync(path, "utf8").trim();
    if (txt === "") return null;
    const n = Number.parseInt(txt, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
function readTextFile(path) {
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}
function nowSec() {
  return Math.floor(Date.now() / 1e3);
}
function isProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const errno = e.code;
    if (errno === "EPERM") return true;
    return false;
  }
}
function readDaemonState(name) {
  const pid = readIntFile(codexPidFile(name));
  const startedAt = readIntFile(codexStartedAtFile(name));
  if (pid === null || startedAt === null) return null;
  return {
    name,
    pid,
    startedAt,
    socketPath: codexSocketPath(name),
    threadId: readTextFile(codexThreadFile(name)),
    lastSeen: readIntFile(codexLastSeenFile(name))
  };
}
function daemonAlive(name) {
  const state = readDaemonState(name);
  if (state === null) return false;
  return isProcessAlive(state.pid);
}
function listDaemons() {
  try {
    return readdirSync(codexRegistryRoot()).sort();
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}
async function spawnDaemon(opts) {
  const { name } = opts;
  const binPath = opts.binPath ?? (process.env["CLAUDEMUX_CODEX_BIN"] || "codex");
  const dir = codexTeammateDir(name);
  const socketPath = codexSocketPath(name);
  const readyTimeoutMs = opts.readyTimeoutMs ?? 1e4;
  if (daemonAlive(name)) {
    throw new Error(
      `codex daemon '${name}' is already alive (pid ${readDaemonState(name)?.pid ?? "?"}); reap it first with tm doctor / tm kill`
    );
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const args = ["app-server", "--listen", `unix://${socketPath}`, ...opts.extraArgs ?? []];
  const spawnOpts = {
    cwd: opts.cwd ?? process.cwd(),
    env: opts.env ?? process.env,
    detached: true,
    stdio: "ignore"
  };
  let child;
  try {
    child = await new Promise((resolve, reject) => {
      let settled = false;
      const c = spawnChild(binPath, args, spawnOpts);
      c.once("error", (e) => {
        if (settled) return;
        settled = true;
        reject(e instanceof Error ? e : new Error(String(e)));
      });
      c.once("spawn", () => {
        if (settled) return;
        settled = true;
        resolve(c);
      });
    });
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(
      `codex daemon '${name}' failed to spawn ${binPath}: ${e.message}`
    );
  }
  child.unref();
  child.on("error", () => {
  });
  const pid = child.pid;
  if (pid === void 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`codex daemon '${name}' spawned without a pid`);
  }
  const startedAt = nowSec();
  atomicWrite(codexPidFile(name), `${pid}
`);
  atomicWrite(codexStartedAtFile(name), `${startedAt}
`);
  if (opts.meta !== void 0 && opts.meta !== null) {
    atomicWrite(codexMetaFile(name), JSON.stringify(opts.meta, null, 2) + "\n");
  }
  try {
    await waitForSocket(socketPath, pid, readyTimeoutMs);
  } catch (e) {
    if (isProcessAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
      }
    }
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return {
    name,
    pid,
    startedAt,
    socketPath,
    threadId: null,
    lastSeen: null
  };
}
async function waitForSocket(path, pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      try {
        const st = statSync(path);
        if (st.isSocket()) return;
      } catch {
      }
    }
    if (!isProcessAlive(pid)) {
      throw new Error(
        `codex daemon (pid ${pid}) exited before binding ${path}`
      );
    }
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(
    `codex daemon (pid ${pid}) did not bind ${path} within ${timeoutMs}ms`
  );
}
async function reapDaemon(name) {
  const state = readDaemonState(name);
  if (state !== null && isProcessAlive(state.pid)) {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
    }
    const deadline = Date.now() + 1e3;
    while (Date.now() < deadline) {
      if (!isProcessAlive(state.pid)) break;
      await new Promise((res) => setTimeout(res, 25));
    }
    if (isProcessAlive(state.pid)) {
      try {
        process.kill(state.pid, "SIGKILL");
      } catch {
      }
    }
  }
  rmSync(codexTeammateDir(name), { recursive: true, force: true });
}
function touchLastSeen(name) {
  writeFileSync(codexLastSeenFile(name), `${nowSec()}
`);
}
function writeThreadId(name, threadId) {
  atomicWrite(codexThreadFile(name), `${threadId}
`);
}

// src/codex-verbs.ts
var CLIENT_INFO = {
  name: "claudemux",
  title: null,
  version: "1.0.0-beta.0"
};
function die(message) {
  return { code: 1, stdout: "", stderr: `tm: ${message}
` };
}
function isCodexTarget(name) {
  return name.startsWith("codex-");
}
async function openInitialized(name) {
  const client = new CodexWsClient({ socketPath: codexSocketPath(name) });
  await client.ready();
  await client.request("initialize", {
    clientInfo: CLIENT_INFO,
    capabilities: {
      // Opt into the experimental methods the codex protocol marks
      // upstream — every verb here uses one (thread/start, turn/start,
      // turn/completed). Without this opt-in the daemon would suppress
      // them.
      experimentalApi: true,
      requestAttestation: false
    }
  });
  return client;
}
function readThreadId(name) {
  try {
    const txt = readFileSync2(codexThreadFile(name), "utf8").trim();
    return txt.length === 0 ? null : txt;
  } catch {
    return null;
  }
}
function waitForNotification(client, method) {
  return new Promise((resolve) => {
    client.onNotification((notif) => {
      if (notif.method === method) {
        resolve(notif);
      }
    });
  });
}
async function codexSpawn(name) {
  try {
    const state = await spawnDaemon({ name });
    return {
      code: 0,
      stdout: "",
      stderr: `spawned: ${name} (pid=${state.pid}, socket=${state.socketPath})
`
    };
  } catch (e) {
    return die(e.message);
  }
}
async function runTurn(client, threadId, prompt, wait2) {
  const completed = wait2 ? waitForNotification(client, "turn/completed") : null;
  await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: prompt, text_elements: [] }]
  });
  if (completed === null) return null;
  const notif = await completed;
  return notif.params;
}
async function codexSend(name, prompt, opts = {}) {
  if (!daemonAlive(name)) {
    return die(
      `codex teammate '${name}' is not alive \u2014 try 'tm spawn ${name}' first`
    );
  }
  if (prompt.length === 0) {
    return die('usage: tm send <teammate> "<prompt>"');
  }
  const noWait = opts.noWait ?? false;
  let client = null;
  try {
    client = await openInitialized(name);
    let threadId = readThreadId(name);
    if (threadId === null) {
      const resp = await client.request(
        "thread/start",
        {
          experimentalRawEvents: false,
          persistExtendedHistory: false
        }
      );
      threadId = resp.thread.id;
      writeThreadId(name, threadId);
    }
    const params = await runTurn(client, threadId, prompt, !noWait);
    touchLastSeen(name);
    if (params === null) {
      return {
        code: 0,
        stdout: "",
        stderr: `sent: ${name} (thread=${threadId}, --no-wait; use 'tm wait ${name}' for the reply)
`
      };
    }
    return {
      code: 0,
      stdout: JSON.stringify(params, null, 2) + "\n",
      stderr: ""
    };
  } catch (e) {
    return die(
      `codex send on '${name}' failed: ${e instanceof Error ? e.message : String(e)}`
    );
  } finally {
    if (client !== null) client.close();
  }
}
async function codexWait(name) {
  if (!daemonAlive(name)) {
    return die(`codex teammate '${name}' is not alive`);
  }
  let client = null;
  try {
    client = await openInitialized(name);
    const completed = await waitForNotification(client, "turn/completed");
    touchLastSeen(name);
    return {
      code: 0,
      stdout: JSON.stringify(completed.params, null, 2) + "\n",
      stderr: ""
    };
  } catch (e) {
    return die(
      `codex wait on '${name}' failed: ${e instanceof Error ? e.message : String(e)}`
    );
  } finally {
    if (client !== null) client.close();
  }
}
async function codexKill(name) {
  const state = readDaemonState(name);
  await reapDaemon(name);
  if (state === null) {
    return {
      code: 0,
      stdout: "",
      stderr: `no codex teammate '${name}' to kill (already gone)
`
    };
  }
  return {
    code: 0,
    stdout: "",
    stderr: `killed: ${name} (was pid=${state.pid})
`
  };
}
function tryBorrow(name) {
  const lockPath = join2(codexTeammateDir(name), "lock");
  try {
    const fd = openSync2(lockPath, "wx", 384);
    try {
      writeSync2(fd, `${process.pid}
`);
    } finally {
      closeSync2(fd);
    }
    return true;
  } catch {
    return false;
  }
}
function releaseBorrow(name) {
  rmSync2(join2(codexTeammateDir(name), "lock"), { force: true });
}
async function codexAsk(prompt) {
  if (prompt.length === 0) {
    return die('usage: tm ask "<prompt>"');
  }
  const candidates = listDaemons().filter(isCodexTarget);
  if (candidates.length === 0) {
    return die(
      "no codex teammates available \u2014 run 'tm spawn codex-1' (or similar) first"
    );
  }
  let borrowed = null;
  let aliveCount = 0;
  for (const name of candidates) {
    if (!daemonAlive(name)) continue;
    aliveCount += 1;
    if (tryBorrow(name)) {
      borrowed = name;
      break;
    }
  }
  if (borrowed === null) {
    if (aliveCount === 0) {
      return die(
        `all ${candidates.length} codex teammate(s) are dead \u2014 'tm doctor' will reap them`
      );
    }
    return die(
      `all ${aliveCount} alive codex teammate(s) are busy \u2014 retry, or spawn another`
    );
  }
  let client = null;
  try {
    client = await openInitialized(borrowed);
    const resp = await client.request(
      "thread/start",
      {
        // Daemon-side throwaway thread: codex treats it as not part of
        // the teammate's persistent history, and frees it once the turn
        // completes. Without this the borrow leaks one server-side
        // thread per ask, accumulating over the daemon's lifetime.
        ephemeral: true,
        experimentalRawEvents: false,
        persistExtendedHistory: false
      }
    );
    const params = await runTurn(client, resp.thread.id, prompt, true);
    touchLastSeen(borrowed);
    return {
      code: 0,
      stdout: JSON.stringify(params, null, 2) + "\n",
      stderr: ""
    };
  } catch (e) {
    return die(
      `codex ask on '${borrowed}' failed: ${e instanceof Error ? e.message : String(e)}`
    );
  } finally {
    if (client !== null) client.close();
    releaseBorrow(borrowed);
  }
}

// src/native.ts
var SESSION_PREFIX = "teammate-";
function die2(message) {
  return { code: 1, stdout: "", stderr: `tm: ${message}
` };
}
function sessionField(line) {
  const colon = line.indexOf(":");
  return colon >= 0 ? line.slice(0, colon) : line;
}
var ls = async (_args, _options, env) => {
  let listing = "";
  try {
    listing = (await env.runTmux(["ls"])).stdout;
  } catch {
    listing = "";
  }
  const rows = listing.split("\n").filter((line) => sessionField(line).startsWith(SESSION_PREFIX));
  const text = rows.length > 0 ? `${rows.join("\n")}
` : "(no teammate sessions; use 'tm spawn <repo>')\n";
  return { code: 0, stdout: text, stderr: "" };
};
function resolveSid(repo) {
  try {
    const file = sidFile(repo);
    if (statSync2(file).size === 0) return null;
    return readFileSync3(file, "utf8").replace(/\n+$/, "");
  } catch {
    return null;
  }
}
function readIfNonEmpty(file) {
  try {
    if (statSync2(file).size === 0) return null;
    return readFileSync3(file, "utf8");
  } catch {
    return null;
  }
}
var last = async (args) => {
  const repo = args[0] ?? "";
  if (repo.length === 0) return die2("usage: tm last <repo>");
  const sid = resolveSid(repo);
  if (sid === null) {
    return die2(
      `no sid file for ${repo} at ${sidFile(repo)} \u2014 was this teammate spawned via 'tm spawn'? (raw 'tmux new-session' won't seed the sid)`
    );
  }
  const file = lastFileFor(sid);
  const reply = readIfNonEmpty(file);
  if (reply === null) {
    return die2(
      `no reply yet for ${repo} (sid=${sid}) \u2014 file is missing or empty at ${file}. Try 'tm wait ${repo}' to block for the next Stop, or 'tm send ${repo} --prompt "..."' to drive a turn.`
    );
  }
  return { code: 0, stdout: reply, stderr: "" };
};
function usageInput(usage) {
  const num = (v) => typeof v === "number" ? v : 0;
  return num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens);
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readCtxUsage(jsonl) {
  let content;
  try {
    content = readFileSync3(jsonl, "utf8");
  } catch {
    return null;
  }
  const inputs = [];
  let lastOut = 0;
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return null;
    }
    if (entry === null) continue;
    if (!isPlainObject(entry)) return null;
    if (entry.type !== "assistant") continue;
    const message = entry.message;
    if (message === null || message === void 0) continue;
    if (!isPlainObject(message)) return null;
    const usage = message.usage;
    if (usage === null || usage === void 0) continue;
    if (!isPlainObject(usage)) return null;
    inputs.push(usageInput(usage));
    lastOut = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  }
  if (inputs.length === 0) return null;
  let peak = inputs[0];
  for (const value of inputs) if (value > peak) peak = value;
  return { used: inputs[inputs.length - 1], out: lastOut, peak };
}
function transcriptFile(projectsDir, cwd, sid) {
  return join3(projectsDir, encodeProjectDir(cwd), `${sid}.jsonl`);
}
function isRegularFile(path) {
  try {
    return statSync2(path).isFile();
  } catch {
    return false;
  }
}
function isDirectory(path) {
  try {
    return statSync2(path).isDirectory();
  } catch {
    return false;
  }
}
function ctxLine(repo, windowOverride, env) {
  const sid = resolveSid(repo);
  if (sid === null) return `${repo}: ? (no sid file)`;
  const recordedCwd = readIfNonEmpty(cwdFile(repo));
  const cwd = recordedCwd !== null ? recordedCwd.replace(/\n+$/, "") : `${env.dispatcherDir}/${repo}`;
  const jsonl = transcriptFile(env.projectsDir, cwd, sid);
  if (!isRegularFile(jsonl)) return `${repo}: ? (no transcript at ${jsonl})`;
  const usage = readCtxUsage(jsonl);
  if (usage === null) return `${repo}: ? (no assistant usage in transcript)`;
  const next = usage.used + usage.out;
  let window;
  let note;
  if (windowOverride === "1m") {
    window = 1e6;
    note = "flag";
  } else if (windowOverride === "200k") {
    window = 2e5;
    note = "flag";
  } else if (usage.peak > 21e4) {
    window = 1e6;
    note = "detected 1M";
  } else {
    window = 2e5;
    note = "assumed 200k";
  }
  const pct = Math.floor(usage.used * 100 / window);
  const wlabel = window >= 1e6 ? "1M" : "200k";
  return `${repo}: ${usage.used} tokens \xB7 ~${next} next turn \xB7 ${pct}% of ${wlabel} (${note})`;
}
async function iterRepos(runTmux2) {
  let listing = "";
  try {
    listing = (await runTmux2(["ls"])).stdout;
  } catch {
    listing = "";
  }
  const repos = [];
  for (const line of listing.split("\n")) {
    const field = sessionField(line);
    if (field.startsWith(SESSION_PREFIX)) repos.push(field.slice(SESSION_PREFIX.length));
  }
  return repos;
}
function parseCtxArgs(args) {
  const repos = [];
  let windowOverride = "";
  let all = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--all") {
      all = true;
    } else if (arg === "--window") {
      if (i + 1 >= args.length) return { error: { code: 1, stdout: "", stderr: "" } };
      windowOverride = args[i + 1];
      i++;
    } else if (arg.startsWith("--window=")) {
      windowOverride = arg.slice("--window=".length);
    } else if (arg.startsWith("-")) {
      return { error: die2(`tm ctx: unknown flag: ${arg}`) };
    } else {
      repos.push(arg);
    }
  }
  if (windowOverride !== "" && windowOverride !== "200k" && windowOverride !== "1m") {
    return { error: die2("tm ctx: --window must be 200k or 1m") };
  }
  return { repos, windowOverride, all };
}
var ctx = async (args, _options, env) => {
  const parsed = parseCtxArgs(args);
  if ("error" in parsed) return parsed.error;
  const repos = [...parsed.repos];
  if (parsed.all) repos.push(...await iterRepos(env.runTmux));
  if (repos.length === 0) {
    return die2("usage: tm ctx <repo> [<repo>...] | --all  [--window 200k|1m]");
  }
  const lines = repos.map((repo) => ctxLine(repo, parsed.windowOverride, env));
  return { code: 0, stdout: `${lines.join("\n")}
`, stderr: "" };
};
function fmtAge(age) {
  if (age < 60) return `${age}s`;
  if (age < 3600) return `${Math.floor(age / 60)}m`;
  if (age < 86400) return `${Math.floor(age / 3600)}h`;
  return `${Math.floor(age / 86400)}d`;
}
function lastPreview(lastFile) {
  let content;
  try {
    content = readFileSync3(lastFile, "utf8");
  } catch {
    return "(no first line)";
  }
  const preview = [...content.split("\n")[0] ?? ""].filter((ch) => (ch.codePointAt(0) ?? 0) > 31).slice(0, 50).join("");
  return preview.length > 0 ? preview : "(no first line)";
}
function statesRow(repo, now) {
  const sid = resolveSid(repo);
  const sidShort = sid === null ? "?" : sid.slice(0, 8);
  const busy = sid !== null && isRegularFile(busyMarkerFor(sid)) ? "yes" : "no";
  let last2 = "-";
  let preview = "-";
  if (sid !== null && sid.length > 0) {
    const lf = lastFileFor(sid);
    let stat;
    try {
      stat = statSync2(lf);
    } catch {
      stat = null;
    }
    if (stat !== null && stat.size > 0) {
      const age = now - Math.floor(stat.mtimeMs / 1e3);
      last2 = `${stat.size}B/${fmtAge(age)}`;
      preview = lastPreview(lf);
    }
  }
  return [repo, sidShort, busy, last2, preview];
}
var states = async (_args, _options, env) => {
  const repos = await iterRepos(env.runTmux);
  if (repos.length === 0) return { code: 0, stdout: "(no teammate sessions)\n", stderr: "" };
  const now = Math.floor(Date.now() / 1e3);
  const rows = [
    ["REPO", "SID", "BUSY", "LAST", "PREVIEW"],
    ...repos.map((repo) => statesRow(repo, now))
  ];
  return env.runColumn(`${rows.map((row) => row.join("	")).join("\n")}
`);
};
function dieRepoNotFound(verb, repo, path, dispatcherDir) {
  if (isDirectory(join3(dispatcherDir, ".git"))) {
    return die2(
      `${dispatcherDir} looks like a git working tree (.git exists), not a dispatcher root.
    The dispatcher dir should be the PARENT of your sibling repos.
    Try:  cd "${dirname(dispatcherDir)}" && tm ${verb} ${repo}
    (Or set TM_DISPATCHER_DIR in your dispatcher's .claude/settings.json
    \u2014 run /claudemux:setup to wire it up automatically.)`
    );
  }
  return die2(
    `repo not found at ${path} \u2014 <repo> must be a direct subdirectory of the dispatcher dir (${dispatcherDir}). Dispatcher dir is read from TM_DISPATCHER_DIR (env) or $PWD; if it's wrong, set TM_DISPATCHER_DIR or run tm from the right place.`
  );
}
function projectDirForRepo(repo, env) {
  const phys = realpathSync(join3(env.dispatcherDir, repo));
  return join3(env.projectsDir, encodeProjectDir(phys));
}
var mem = async (args, _options, env) => {
  const repo = args[0] ?? "";
  if (repo.length === 0) return die2("usage: tm mem <repo>");
  const path = join3(env.dispatcherDir, repo);
  if (!isDirectory(path)) return dieRepoNotFound("mem", repo, path, env.dispatcherDir);
  const mfile = join3(projectDirForRepo(repo, env), "memory", "MEMORY.md");
  if (!isRegularFile(mfile)) {
    return {
      code: 0,
      stdout: "",
      stderr: `tm mem: no auto-memory recorded for ${repo} (looked at ${mfile})
`
    };
  }
  return { code: 0, stdout: readFileSync3(mfile, "utf8"), stderr: "" };
};
function toFixed1HalfEven(value) {
  const tenths = value * 10;
  const floor = Math.floor(tenths);
  const frac = tenths - floor;
  let rounded;
  if (frac < 0.5) rounded = floor;
  else if (frac > 0.5) rounded = floor + 1;
  else rounded = floor % 2 === 0 ? floor : floor + 1;
  return (rounded / 10).toFixed(1);
}
function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${Math.trunc(bytes / 1024)}K`;
  if (bytes < 1073741824) return `${toFixed1HalfEven(bytes / 1048576)}M`;
  return `${toFixed1HalfEven(bytes / 1073741824)}G`;
}
function fmtLocalDateTime(epochSec) {
  const d = new Date(epochSec * 1e3);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function mungeCreated(ts) {
  return ts.replace("T", " ").replace(/\.[0-9]+Z?$/, "").replace(/Z$/, "");
}
function indent(text) {
  return text.split("\n").map((line) => `  ${line}`).join("\n");
}
function bashNum(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : 0;
}
function contentTextItems(content) {
  let hasText = false;
  const texts = [];
  for (const item of content) {
    if (!isPlainObject(item)) throw new Error("jq-fail");
    if (item.type === "text") {
      hasText = true;
      const t = item.text;
      if (t === null || t === void 0) texts.push("");
      else if (typeof t === "string") texts.push(t);
      else throw new Error("jq-fail");
    }
  }
  return hasText ? texts : null;
}
function userPromptText(entry) {
  const message = entry.message;
  if (message === null || message === void 0) return null;
  if (!isPlainObject(message)) throw new Error("jq-fail");
  if (message.role !== "user") return null;
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = contentTextItems(content);
    return texts === null ? null : texts.join(" ");
  }
  return null;
}
function historyUsageSum(usage) {
  if (!isPlainObject(usage)) throw new Error("jq-fail");
  let sum = null;
  for (const key of [
    "input_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens"
  ]) {
    const value = usage[key];
    if (value === null || value === void 0) continue;
    if (typeof value !== "number") throw new Error("jq-fail");
    sum = (sum ?? 0) + value;
  }
  return sum;
}
function historyUsageStr(sum) {
  return sum === null ? "null" : String(sum);
}
function historyFirstPrompt(content) {
  for (const line of content.split("\n").slice(0, 200)) {
    if (line.trim() === "") continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPlainObject(entry) || entry.type !== "user") continue;
    let text;
    try {
      text = userPromptText(entry);
    } catch {
      continue;
    }
    if (text === null) continue;
    return text.split("\n")[0] ?? "";
  }
  return "";
}
function historyTopic(content) {
  const stripped = [...historyFirstPrompt(content)].filter(
    (ch) => (ch.codePointAt(0) ?? 0) > 31
  );
  const topic = stripped.slice(0, 60).join("");
  return topic.length > 0 ? topic : "(no user prompt)";
}
var EMPTY_HISTORY = {
  firstPrompt: "",
  lastAssistant: "",
  createdTs: "",
  used: "",
  peak: ""
};
function readHistoryData(content) {
  try {
    const uPrompts = [];
    const aTexts = [];
    const usages = [];
    const timestamps = [];
    for (const line of content.split("\n")) {
      if (line.trim() === "") continue;
      const entry = JSON.parse(line);
      if (entry === null) continue;
      if (!isPlainObject(entry)) throw new Error("jq-fail");
      if (entry.type === "user") {
        const text = userPromptText(entry);
        if (text !== null) uPrompts.push(text);
      } else if (entry.type === "assistant") {
        const message = entry.message;
        if (message !== null && message !== void 0) {
          if (!isPlainObject(message)) throw new Error("jq-fail");
          if (Array.isArray(message.content)) {
            const texts = contentTextItems(message.content);
            if (texts !== null) aTexts.push(texts.join("\n"));
          }
          if (message.usage !== null && message.usage !== void 0) {
            usages.push(message.usage);
          }
        }
      }
      const ts = entry.timestamp;
      if (ts !== null && ts !== void 0) timestamps.push(ts);
    }
    let createdTs = "";
    if (timestamps.length > 0) {
      const first = timestamps[0];
      if (first === false) createdTs = "";
      else if (typeof first === "string") createdTs = first;
      else throw new Error("jq-fail");
    }
    let used = "";
    let peak = "";
    if (usages.length > 0) {
      const sums = usages.map(historyUsageSum);
      used = historyUsageStr(sums[sums.length - 1] ?? null);
      let peakNum = null;
      for (const sum of sums) {
        if (sum !== null && (peakNum === null || sum > peakNum)) peakNum = sum;
      }
      peak = historyUsageStr(peakNum);
    }
    return {
      firstPrompt: (uPrompts[0] ?? "").replace(/\n+$/, ""),
      lastAssistant: (aTexts[aTexts.length - 1] ?? "").replace(/\n+$/, ""),
      createdTs,
      used,
      peak
    };
  } catch {
    return EMPTY_HISTORY;
  }
}
async function historyList(repo, projectDir, env) {
  if (!isDirectory(projectDir)) {
    return { code: 0, stdout: `(no past sessions for ${repo})
`, stderr: "" };
  }
  let names;
  try {
    names = readdirSync2(projectDir).filter((name) => name.endsWith(".jsonl"));
  } catch {
    names = [];
  }
  if (names.length === 0) {
    return { code: 0, stdout: `(no past sessions for ${repo})
`, stderr: "" };
  }
  const files = names.map((name) => {
    let mtime = 0;
    try {
      mtime = Math.floor(statSync2(join3(projectDir, name)).mtimeMs / 1e3);
    } catch {
      mtime = 0;
    }
    return { name, mtime };
  });
  files.sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const liveSid = resolveSid(repo) ?? "";
  const now = Math.floor(Date.now() / 1e3);
  const rows = [[" ", "SID", "AGE", "SIZE", "TOPIC"]];
  for (const { name, mtime } of files) {
    const full = join3(projectDir, name);
    const sidFull = name.replace(/\.jsonl$/, "");
    let size = 0;
    try {
      size = statSync2(full).size;
    } catch {
      size = 0;
    }
    let content = "";
    try {
      content = readFileSync3(full, "utf8");
    } catch {
      content = "";
    }
    const mark = liveSid !== "" && sidFull === liveSid ? "*" : " ";
    rows.push([
      mark,
      sidFull.slice(0, 8),
      fmtAge(now - mtime),
      fmtSize(size),
      historyTopic(content)
    ]);
  }
  return env.runColumn(`${rows.map((row) => row.join("	")).join("\n")}
`);
}
function historyDetail(repo, projectDir, prefix) {
  if (!/^[0-9a-f-]{1,36}$/.test(prefix)) {
    return die2(
      `tm history: invalid sid prefix '${prefix}' \u2014 must match ^[0-9a-f-]{1,36}$`
    );
  }
  if (!isDirectory(projectDir)) {
    return die2(`tm history: no project dir at ${projectDir} for ${repo} (no sessions yet)`);
  }
  let names;
  try {
    names = readdirSync2(projectDir).filter(
      (name2) => name2.startsWith(prefix) && name2.endsWith(".jsonl") && isRegularFile(join3(projectDir, name2))
    );
  } catch {
    names = [];
  }
  names.sort();
  if (names.length === 0) {
    return die2(`tm history: no session matching '${prefix}' in ${repo}`);
  }
  if (names.length > 1) {
    const cands = `${names.map((name2) => name2.replace(/\.jsonl$/, "")).join(" ")} `;
    return die2(
      `tm history: prefix '${prefix}' matches ${names.length} sessions \u2014 be more specific: ${cands}`
    );
  }
  const name = names[0];
  const file = join3(projectDir, name);
  const sidFull = name.replace(/\.jsonl$/, "");
  let size = 0;
  let mtime = 0;
  try {
    const stat = statSync2(file);
    size = stat.size;
    mtime = Math.floor(stat.mtimeMs / 1e3);
  } catch {
    size = 0;
    mtime = 0;
  }
  let content = "";
  try {
    content = readFileSync3(file, "utf8");
  } catch {
    content = "";
  }
  const lineCount = (content.match(/\n/g) ?? []).length;
  const now = Math.floor(Date.now() / 1e3);
  const data = readHistoryData(content);
  const createdStr = data.createdTs !== "" ? mungeCreated(data.createdTs) : "";
  let ctxStr = "(no usage data)";
  if (data.used !== "" && data.peak !== "") {
    const window = bashNum(data.peak) > 21e4 ? 1e6 : 2e5;
    const pct = Math.trunc(bashNum(data.used) * 100 / window);
    const wlabel = window >= 1e6 ? "1M" : "200k";
    const note = window >= 1e6 ? "detected 1M" : "assumed 200k";
    ctxStr = `${data.used} tokens \xB7 ${pct}% of ${wlabel} (${note})`;
  }
  let laDisplay = data.lastAssistant !== "" ? data.lastAssistant : "(no assistant text)";
  if (data.lastAssistant !== "") {
    const cps = [...data.lastAssistant];
    if (cps.length > 1500) {
      laDisplay = `${cps.slice(0, 1500).join("")}
... (${cps.length - 1500} chars truncated; full text in jsonl)`;
    }
  }
  const fpDisplay = data.firstPrompt !== "" ? data.firstPrompt : "(no user prompt)";
  const stdout = `sid:        ${sidFull}
file:       ${file}
            (${fmtSize(size)} \xB7 ${lineCount} lines)
created:    ${createdStr !== "" ? createdStr : "(unknown)"}
last_seen:  ${fmtLocalDateTime(mtime)}  (${fmtAge(now - mtime)} ago)
ctx:        ${ctxStr}

first prompt:
${indent(fpDisplay)}

last assistant:
${indent(laDisplay)}

resume: tm resume ${repo} ${sidFull}
`;
  return { code: 0, stdout, stderr: "" };
}
var history = async (args, _options, env) => {
  const repo = args[0] ?? "";
  if (repo.length === 0) return die2("usage: tm history <repo> [<sid-or-prefix>]");
  const path = join3(env.dispatcherDir, repo);
  if (!isDirectory(path)) return dieRepoNotFound("history", repo, path, env.dispatcherDir);
  const projectDir = projectDirForRepo(repo, env);
  const sidArg = args[1] ?? "";
  return sidArg === "" ? historyList(repo, projectDir, env) : historyDetail(repo, projectDir, sidArg);
};
async function requireSession(repo, runTmux2) {
  const name = `${SESSION_PREFIX}${repo}`;
  let exists = false;
  try {
    exists = (await runTmux2(["has-session", "-t", `=${name}`])).code === 0;
  } catch {
    exists = false;
  }
  return exists ? null : die2(`no such teammate session: ${repo} (tmux=${name}; try 'tm ls')`);
}
async function resolvePaneTarget(repo, runTmux2) {
  const name = `${SESSION_PREFIX}${repo}`;
  let listing = "";
  try {
    listing = (await runTmux2(["list-sessions", "-F", "#{session_id} #{session_name}"])).stdout;
  } catch {
    listing = "";
  }
  for (const line of listing.split("\n")) {
    const space = line.indexOf(" ");
    if (space >= 0 && line.slice(space + 1) === name) return line.slice(0, space);
  }
  return "";
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
var status = async (args, _options, env) => {
  const repo = args[0] ?? "";
  if (repo.length === 0) return die2("usage: tm status <repo> [lines=80]");
  const lines = args[1] || "80";
  const sessionMissing = await requireSession(repo, env.runTmux);
  if (sessionMissing !== null) return sessionMissing;
  const pane = await resolvePaneTarget(repo, env.runTmux);
  if (pane === "") return die2(`could not resolve pane target for ${repo}`);
  return env.runTmux(["capture-pane", "-t", pane, "-p", "-S", `-${lines}`]);
};
var poll = async (args, _options, env) => {
  const repo = args[0] ?? "";
  const pattern = args[1] ?? "";
  if (repo === "" || pattern === "") {
    return die2("usage: tm poll <repo> <regex> [timeout=180]");
  }
  const timeoutArg = args[2] || "180";
  const sessionMissing = await requireSession(repo, env.runTmux);
  if (sessionMissing !== null) return sessionMissing;
  const pane = await resolvePaneTarget(repo, env.runTmux);
  if (pane === "") return die2(`could not resolve pane target for ${repo}`);
  if (!isNonNegativeInteger(timeoutArg)) return { code: 1, stdout: "", stderr: "" };
  const end = Math.floor(Date.now() / 1e3) + Number(timeoutArg);
  while (Math.floor(Date.now() / 1e3) < end) {
    const capture = await env.runTmux(["capture-pane", "-t", pane, "-p", "-S", "-300"]);
    if (capture.code === 0 && await env.runGrep(pattern, capture.stdout) === 0) {
      return { code: 0, stdout: `matched: ${pattern}
`, stderr: "" };
    }
    await sleep(3e3);
  }
  return {
    code: 1,
    stdout: "",
    stderr: `tm: timeout after ${timeoutArg}s waiting for /${pattern}/ in ${repo}
`
  };
};
function clearIdle(sid) {
  if (sid === "") return;
  for (const file of [idleMarkerFor(sid), lastFileFor(sid), busyMarkerFor(sid)]) {
    rmSync3(file, { force: true });
  }
}
var kill = async (args, _options, env) => {
  const repo = args[0] ?? "";
  if (repo.length === 0) return die2("usage: tm kill <repo>");
  if (isCodexTarget(repo)) return codexKill(repo);
  const name = `${SESSION_PREFIX}${repo}`;
  const sid = resolveSid(repo);
  if (sid !== null) clearIdle(sid);
  for (const file of [sidFile(repo), sendAtFile(repo), readyFile(repo), cwdFile(repo)]) {
    rmSync3(file, { force: true });
  }
  let running = false;
  try {
    running = (await env.runTmux(["has-session", "-t", `=${name}`])).code === 0;
  } catch {
    running = false;
  }
  if (running) {
    await env.runTmux(["kill-session", "-t", `=${name}`]);
    return { code: 0, stdout: `killed: ${repo} (tmux=${name})
`, stderr: "" };
  }
  return { code: 0, stdout: `not running: ${repo} (tmux=${name})
`, stderr: "" };
};
var ARCHIVE_TEMPLATE = `${[
  "---",
  "name: dispatcher-tasks-archive",
  'description: "On-demand archive of closed dispatcher tasks, compressed to outcome + artifacts. NOT a boot read \u2014 only consult when looking up past task history. Live in-flight tasks live in active-dispatcher-tasks.md."',
  "metadata:",
  "  node_type: memory",
  "  type: project",
  "---",
  "",
  "# Dispatcher task archive",
  "",
  "Closed tasks moved here from `active-dispatcher-tasks.md`, compressed to a",
  "pointer + conclusion (not a knowledge base). Newest on top. Reusable analysis",
  "that outlives a task should be promoted to its own memory file, not kept here.",
  "",
  "<!-- split by month (dispatcher-tasks-archive-YYYY-MM.md) if this file grows past a few hundred entries -->"
].join("\n")}
`;
function fmtLocalDate() {
  const d = /* @__PURE__ */ new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function ledgerLines(content) {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
function parseArchiveArgs(args) {
  let id = "";
  let status2 = "";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--status") {
      if (i + 1 >= args.length) return { error: { code: 1, stdout: "", stderr: "" } };
      status2 = args[i + 1];
      i++;
    } else if (arg.startsWith("--status=")) {
      status2 = arg.slice("--status=".length);
    } else if (arg.startsWith("-")) {
      return { error: die2(`tm archive: unknown flag: ${arg}`) };
    } else if (id === "") {
      id = arg;
    } else {
      return { error: die2(`tm archive: unexpected arg: ${arg}`) };
    }
  }
  return { id, status: status2 };
}
var archive = async (args, options, env) => {
  const parsed = parseArchiveArgs(args);
  if ("error" in parsed) return parsed.error;
  const { id } = parsed;
  if (id === "") {
    return die2("usage: tm archive <id> [--status '<tag>']   (outcome text on stdin)");
  }
  const memoryDir = join3(env.projectsDir, encodeProjectDir(env.dispatcherDir), "memory");
  const activePath = join3(memoryDir, "active-dispatcher-tasks.md");
  const archivePath = join3(memoryDir, "dispatcher-tasks-archive.md");
  if (!isRegularFile(activePath)) return die2(`no active ledger at ${activePath}`);
  const outcome = (options?.stdin ?? "").replace(/\n+$/, "");
  if (outcome.replace(/\s/g, "") === "") {
    return die2(`outcome text required on stdin, e.g.:  echo '...' | tm archive ${id}`);
  }
  const activeContent = readFileSync3(activePath, "utf8");
  const activeLines = ledgerLines(activeContent);
  let headerRe;
  try {
    headerRe = new RegExp(`^### ${id}(\\s|$)`);
  } catch {
    headerRe = /(?!)/;
  }
  const headerLines = activeLines.map((line, index) => headerRe.test(line) ? index + 1 : 0).filter((lineNo) => lineNo > 0);
  if (headerLines.length === 0) {
    const available = activeLines.map((line) => /^### [^ ]+/.exec(line)?.[0]).filter((match) => match != null).map((match) => match.slice("### ".length)).join(" ");
    return die2(`id not found in active ledger: ${id}
  available: ${available}`);
  }
  if (headerLines.length !== 1) {
    return die2(`id matches ${headerLines.length} entries in active ledger: ${id}`);
  }
  const start = headerLines[0];
  const total = (activeContent.match(/\n/g) ?? []).length;
  let end = total;
  for (let index = start; index < activeLines.length; index++) {
    if (/^(### |## )/.test(activeLines[index])) {
      end = index;
      break;
    }
  }
  const blockLines = activeLines.slice(start - 1, end);
  let status2 = parsed.status;
  if (status2 === "") {
    const tag = /\[(.+)\]\s*$/.exec(blockLines[0] ?? "");
    status2 = tag ? tag[1] : "done";
  }
  const field = (name) => {
    const line = blockLines.find((candidate) => candidate.startsWith(`- ${name}:`));
    if (line === void 0) return "(unknown)";
    const value = line.slice(`- ${name}:`.length).replace(/^\s*/, "");
    return value === "" ? "(unknown)" : value;
  };
  const entry = `### ${id}  [${status2}]
- repo/branch: ${field("repo")} / ${field("branch")}
- intent: ${field("intent")}
- outcome: ${outcome}
- closed: ${fmtLocalDate()}`;
  const archiveContent = isRegularFile(archivePath) ? readFileSync3(archivePath, "utf8") : ARCHIVE_TEMPLATE;
  const archiveLines = ledgerLines(archiveContent);
  let firstEntry = 0;
  for (let index = 0; index < archiveLines.length; index++) {
    if (archiveLines[index].startsWith("### ")) {
      firstEntry = index + 1;
      break;
    }
  }
  let newArchive;
  if (firstEntry > 0) {
    const head = firstEntry > 1 ? `${archiveLines.slice(0, firstEntry - 1).join("\n")}
` : "";
    const tail = `${archiveLines.slice(firstEntry - 1).join("\n")}
`;
    newArchive = `${head}${entry}

${tail}`;
  } else {
    newArchive = `${archiveContent}
${entry}
`;
  }
  const remaining = [...activeLines.slice(0, start - 1), ...activeLines.slice(end)];
  const newActive = remaining.length > 0 ? `${remaining.join("\n")}
` : "";
  writeFileSync2(archivePath, newArchive);
  writeFileSync2(activePath, newActive);
  return {
    code: 0,
    stdout: `archived ${id}  [${status2}] -> dispatcher-tasks-archive.md  (removed from active ledger)
`,
    stderr: ""
  };
};
var reload = async (args, _options, env) => {
  let all = false;
  const repos = [];
  for (const arg of args) {
    if (arg === "--all") all = true;
    else if (arg === "-h" || arg === "--help") return die2("usage: tm reload <repo>... | --all");
    else if (arg.startsWith("-")) return die2(`tm reload: unknown flag: ${arg}`);
    else repos.push(arg);
  }
  if (all) {
    if (repos.length > 0) return die2("tm reload: --all conflicts with explicit repos");
    repos.push(...await iterRepos(env.runTmux));
    if (repos.length === 0) {
      return { code: 0, stdout: "(no teammate sessions to reload)\n", stderr: "" };
    }
  } else if (repos.length === 0) {
    return die2("usage: tm reload <repo>... | --all");
  }
  let stdout = "";
  for (const repo of repos) {
    stdout += `\u2192 ${repo}: /reload-plugins
`;
    const sent = await send(["--no-wait", repo, "--prompt", "/reload-plugins"], void 0, env);
    if (sent.code !== 0) return { code: sent.code, stdout, stderr: "" };
  }
  return { code: 0, stdout, stderr: "" };
};
function resolveSidOrDie(repo) {
  const sid = resolveSid(repo);
  if (sid === null) {
    return {
      error: die2(
        `no sid file for ${repo} at ${sidFile(repo)} \u2014 was this teammate spawned via 'tm spawn'? (raw 'tmux new-session' won't seed the sid)`
      )
    };
  }
  return { sid };
}
function newSid() {
  return randomUUID().toLowerCase();
}
function randSuffix() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(4);
  let out = "";
  for (let i = 0; i < 4; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
function sanitizeTaskSlug(task) {
  let s = task.toLowerCase();
  s = s.replace(/[^a-z0-9一-鿿]+/g, "-");
  s = s.replace(/^-+|-+$/g, "");
  const cps = [...s];
  if (cps.length > 30) {
    s = cps.slice(0, 30).join("");
    s = s.replace(/-+$/, "");
  }
  return s;
}
function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function nowSec2() {
  return Math.floor(Date.now() / 1e3);
}
function isNonNegativeInteger(value) {
  return /^[0-9]+$/.test(value);
}
function readSendKeysConfig() {
  const inlineRaw = process.env.TM_SEND_INLINE_MAX ?? "";
  const inlineMax = inlineRaw === "" ? 200 : Number(inlineRaw);
  if (inlineRaw !== "" && !/^[0-9]+$/.test(inlineRaw)) {
    return die2(
      `TM_SEND_INLINE_MAX must be a non-negative integer (got: '${inlineRaw}')`
    );
  }
  const gapRaw = process.env.TM_SEND_GAP ?? "";
  if (gapRaw !== "" && !/^[0-9]+(\.[0-9]+)?$/.test(gapRaw)) {
    return die2(
      `TM_SEND_GAP must be a non-negative number of seconds (got: '${gapRaw}')`
    );
  }
  return {
    inlineMax,
    gapOverride: gapRaw === "" ? null : gapRaw
  };
}
function defaultPasteGapSec(promptLength) {
  if (promptLength <= 256) return 0.2;
  if (promptLength <= 1024) return 0.5;
  if (promptLength <= 4096) return 1;
  if (promptLength <= 16384) return 2;
  return 4;
}
async function sendKeys(repo, prompt, env) {
  const sessionMissing = await requireSession(repo, env.runTmux);
  if (sessionMissing !== null) return sessionMissing;
  const pane = await resolvePaneTarget(repo, env.runTmux);
  if (pane === "") return die2(`could not resolve pane target for ${repo}`);
  const cfg = readSendKeysConfig();
  if ("code" in cfg) return cfg;
  const sid = resolveSid(repo);
  if (sid !== null) clearIdle(sid);
  const sa = sendAtFile(repo);
  mkdirSync2(dirname(sa), { recursive: true });
  writeFileSync2(sa, "");
  const n = prompt.length;
  const inlinePath = n <= cfg.inlineMax && !prompt.includes("\n");
  const name = `${SESSION_PREFIX}${repo}`;
  let stderr = `sent to ${repo} (tmux=${name})
`;
  if (sid !== null) stderr += `sid=${sid}
`;
  const tmuxOk = (result, what) => result.code === 0 ? null : die2(`tmux ${what} failed: ${result.stderr.trim() || "non-zero exit"}`);
  if (inlinePath) {
    const sent = await env.runTmux(["send-keys", "-t", pane, "-l", prompt]);
    const sentErr = tmuxOk(sent, "send-keys");
    if (sentErr !== null) return sentErr;
    const enter = await env.runTmux(["send-keys", "-t", pane, "Enter"]);
    const enterErr = tmuxOk(enter, "send-keys Enter");
    if (enterErr !== null) return enterErr;
    return { code: 0, stdout: "", stderr };
  }
  const gap = cfg.gapOverride !== null ? Number(cfg.gapOverride) : defaultPasteGapSec(n);
  const buf = `tm-send-${process.pid}-${randomBytes(2).toString("hex")}`;
  let loaded = false;
  try {
    const loadResult = await env.runTmux(["load-buffer", "-b", buf, "-"], { stdin: prompt });
    const loadErr = tmuxOk(loadResult, "load-buffer");
    if (loadErr !== null) return loadErr;
    loaded = true;
    const pasteResult = await env.runTmux([
      "paste-buffer",
      "-p",
      "-r",
      "-d",
      "-b",
      buf,
      "-t",
      pane
    ]);
    const pasteErr = tmuxOk(pasteResult, "paste-buffer");
    if (pasteErr !== null) return pasteErr;
    loaded = false;
    await sleepMs(Math.round(gap * 1e3));
    const enter = await env.runTmux(["send-keys", "-t", pane, "Enter"]);
    const enterErr = tmuxOk(enter, "send-keys Enter");
    if (enterErr !== null) return enterErr;
  } finally {
    if (loaded) {
      try {
        await env.runTmux(["delete-buffer", "-b", buf]);
      } catch {
      }
    }
  }
  return { code: 0, stdout: "", stderr };
}
async function waitIdleSignal(repo, timeoutSec, fresh, env) {
  const sessionMissing = await requireSession(repo, env.runTmux);
  if (sessionMissing !== null) return sessionMissing;
  const sidR = resolveSidOrDie(repo);
  if ("error" in sidR) return sidR.error;
  if (fresh) clearIdle(sidR.sid);
  const end = nowSec2() + timeoutSec;
  const marker = idleMarkerFor(sidR.sid);
  while (nowSec2() < end) {
    if (existsSync2(marker)) return { ok: true };
    await sleepMs(3e3);
  }
  return { ok: false };
}
async function waitPaneQuiet(repo, timeoutSec, env) {
  const sessionMissing = await requireSession(repo, env.runTmux);
  if (sessionMissing !== null) return sessionMissing;
  let sendAt = 0;
  try {
    const sa = sendAtFile(repo);
    sendAt = Math.floor(statSync2(sa).mtimeMs / 1e3);
  } catch {
    sendAt = 0;
  }
  const end = nowSec2() + timeoutSec;
  let quietStreak = 0;
  while (nowSec2() < end) {
    const sid = resolveSid(repo);
    const isBusy = sid !== null && isRegularFile(busyMarkerFor(sid));
    if (isBusy) quietStreak = 0;
    else quietStreak += 1;
    if (quietStreak >= 2 && nowSec2() - sendAt >= 3) return { ok: true };
    await sleepMs(2e3);
  }
  return { ok: false };
}
function printLastOrEmpty(repo) {
  const sid = resolveSid(repo);
  if (sid === null) return `(no sid for ${repo})
`;
  const reply = readIfNonEmpty(lastFileFor(sid));
  if (reply === null) {
    return "(no text reply this turn \u2014 tool-only, /compact, /clear, or fresh spawn)\n";
  }
  return reply;
}
function echoCtxToStderr(repo, env) {
  const body = ctxLine(repo, "", env);
  if (body.includes(": ? (")) return "";
  const prefix = `${repo}: `;
  const data = body.startsWith(prefix) ? body.slice(prefix.length) : body;
  return `ctx: ${data}
`;
}
var doctor = async (args, _options, env) => {
  if (args.length > 0) {
    return die2(`tm doctor: takes no arguments (got: ${args.join(" ")})`);
  }
  const kv = (label, value) => {
    const padded = `${label}:`.padEnd(20, " ");
    return `  ${padded}${value}
`;
  };
  let out = "";
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const tmWrapper = join3(moduleDir, "..", "..", "bin", "tm");
  const pluginJson = join3(moduleDir, "..", "..", ".claude-plugin", "plugin.json");
  let version = "unknown";
  let pluginJsonPresent = false;
  try {
    if (statSync2(pluginJson).isFile()) {
      pluginJsonPresent = true;
      const parsed = JSON.parse(readFileSync3(pluginJson, "utf8"));
      if (typeof parsed.version === "string" && parsed.version.length > 0) {
        version = parsed.version;
      }
    }
  } catch {
    pluginJsonPresent = false;
  }
  out += "tm executable:\n";
  out += kv("path", tmWrapper);
  out += kv("version", version);
  if (!pluginJsonPresent) out += kv("note", `plugin.json not found at ${pluginJson}`);
  out += "\n";
  out += "dispatcher dir:\n";
  out += kv("resolved", env.dispatcherDir);
  const envSet = process.env.TM_DISPATCHER_DIR;
  if (envSet !== void 0 && envSet.length > 0) {
    out += kv("TM_DISPATCHER_DIR", `set (= ${envSet})`);
  } else {
    out += kv(
      "TM_DISPATCHER_DIR",
      "unset \u2014 falling back to $PWD (run /claudemux:setup to inoculate against cwd drift)"
    );
  }
  const pwd = process.cwd();
  out += kv("$PWD", pwd);
  if (env.dispatcherDir !== pwd) {
    out += kv(
      "status",
      "DIVERGED \u2014 dispatcher dir != $PWD; env override is currently keeping tm correct despite the drifted PWD"
    );
  } else {
    out += kv("status", "matched");
  }
  if (!isDirectory(env.dispatcherDir)) {
    out += kv("warning", `${env.dispatcherDir} does not exist as a directory`);
  }
  out += "\n";
  out += "tmux:\n";
  let tmuxVersionOk = false;
  let tmuxVersionLine = "";
  try {
    const versionResult = await env.runTmux(["-V"]);
    if (versionResult.code === 0) {
      tmuxVersionOk = true;
      tmuxVersionLine = versionResult.stdout.split("\n")[0] ?? "?";
    }
  } catch {
    tmuxVersionOk = false;
  }
  if (!tmuxVersionOk) {
    out += kv("installed", "no (tmux not on PATH \u2014 claudemux teammate workflow needs it)");
  } else {
    out += kv("installed", `yes (${tmuxVersionLine})`);
    let serverRunning = false;
    try {
      serverRunning = (await env.runTmux(["info"])).code === 0;
    } catch {
      serverRunning = false;
    }
    if (serverRunning) out += kv("server", "running");
    else out += kv("server", "not running (no sessions exist yet \u2014 that's fine pre-spawn)");
    const insideTmux = process.env.TMUX ?? "";
    if (insideTmux.length > 0) out += kv("in tmux", `yes (TMUX=${insideTmux})`);
    else out += kv("in tmux", "no \u2014 tm is being run from outside a tmux session");
  }
  out += "\n";
  out += `idle dir (${idleDir()}):
`;
  if (isDirectory(idleDir())) {
    let count = 0;
    try {
      count = readdirSync2(idleDir()).length;
    } catch {
      count = 0;
    }
    out += kv("exists", `yes (${count} file(s))`);
  } else {
    out += kv("exists", "no \u2014 gets created on first tm spawn / scripts/setup.sh");
  }
  out += "\n";
  out += "active teammates:\n";
  let listing = "";
  try {
    listing = (await env.runTmux(["ls"])).stdout;
  } catch {
    listing = "";
  }
  const sessionRows = listing.split("\n").map((line) => sessionField(line)).filter((name) => name.startsWith(SESSION_PREFIX));
  if (sessionRows.length === 0) {
    out += "  (none \u2014 use 'tm spawn <repo>' to launch one)\n";
  } else {
    out += kv("count", String(sessionRows.length));
    for (const name of sessionRows) out += `  ${name}
`;
  }
  out += "\n";
  out += "codex teammates:\n";
  const codexNames = listDaemons();
  if (codexNames.length === 0) {
    out += "  (none \u2014 use 'tm spawn codex-<n>' to launch one)\n";
  } else {
    const reaped = [];
    const live = [];
    for (const name of codexNames) {
      const state = readDaemonState(name);
      if (state === null) {
        reaped.push(name);
        await reapDaemon(name);
      } else if (!isProcessAlive(state.pid)) {
        reaped.push(name);
        await reapDaemon(name);
      } else {
        live.push({ name, pid: state.pid, startedAt: state.startedAt });
      }
    }
    out += kv("count", String(live.length));
    for (const t of live) {
      out += `  ${t.name} (pid=${t.pid}, started ${fmtLocalDateTime(t.startedAt)})
`;
    }
    if (reaped.length > 0) {
      out += kv("reaped orphans", String(reaped.length));
      for (const name of reaped) out += `  ${name}
`;
    }
  }
  return { code: 0, stdout: out, stderr: "" };
};
function parseSpawnArgs(rest) {
  const SILENT = { code: 1, stdout: "", stderr: "" };
  let resumeSid = "";
  let task = "";
  let prompt = "";
  let hasPrompt = false;
  let noWait = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--resume") {
      if (i + 1 >= rest.length) return { error: SILENT };
      resumeSid = rest[i + 1];
      i++;
    } else if (arg === "--task") {
      if (i + 1 >= rest.length) return { error: SILENT };
      task = rest[i + 1];
      i++;
    } else if (arg.startsWith("--task=")) {
      task = arg.slice("--task=".length);
    } else if (arg === "--prompt") {
      if (i + 1 >= rest.length) return { error: die2("tm spawn: --prompt requires a value") };
      prompt = rest[i + 1];
      hasPrompt = true;
      i++;
    } else if (arg.startsWith("--prompt=")) {
      prompt = arg.slice("--prompt=".length);
      hasPrompt = true;
    } else if (arg === "--no-wait") {
      noWait = true;
    } else {
      return { error: die2(`unknown flag: ${arg}`) };
    }
  }
  return { resumeSid, task, prompt, hasPrompt, noWait };
}
function shellSingleQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
function teammateLaunchFlags(mdExcludes) {
  return `--settings ${shellSingleQuote(mdExcludes)} --disallowedTools AskUserQuestion`;
}
async function sessionExists(name, runTmux2) {
  try {
    return (await runTmux2(["has-session", "-t", `=${name}`])).code === 0;
  } catch {
    return false;
  }
}
async function pollReady(repo) {
  const rf = readyFile(repo);
  for (let i = 1; i <= 60; i++) {
    if (existsSync2(rf)) return i * 300;
    await sleepMs(300);
  }
  return null;
}
var spawn2 = async (args, _options, env) => {
  const repo = args[0] ?? "";
  if (repo.length === 0) {
    return die2('usage: tm spawn <repo> [--task <slug>] [--prompt "..."] [--no-wait]');
  }
  if (isCodexTarget(repo)) {
    if (args.length > 1) {
      return die2(
        `tm spawn: codex teammate '${repo}' takes no additional arguments yet (stage 4 surface is just 'tm spawn ${repo}'; --prompt etc. land later)`
      );
    }
    return codexSpawn(repo);
  }
  const parsed = parseSpawnArgs(args.slice(1));
  if ("error" in parsed) return parsed.error;
  const { resumeSid, task, prompt, hasPrompt, noWait } = parsed;
  if (noWait && !hasPrompt) {
    return die2(
      "tm spawn: --no-wait is only valid with --prompt (a fresh spawn without a prompt already returns as soon as the REPL is ready)"
    );
  }
  const path = join3(env.dispatcherDir, repo);
  if (!isDirectory(path)) return dieRepoNotFound("spawn", repo, path, env.dispatcherDir);
  const cwdPhys = realpathSync(path);
  const dispatcherPhys = realpathSync(env.dispatcherDir);
  const mdExcludes = JSON.stringify({
    claudeMdExcludes: [
      `${dispatcherPhys}/CLAUDE.md`,
      `${dispatcherPhys}/CLAUDE.local.md`
    ]
  });
  let displayName = "";
  if (task.length > 0) {
    const slug = sanitizeTaskSlug(task);
    if (slug.length === 0) {
      return die2(
        `tm spawn: --task '${task}' has no usable characters after sanitization (allowlist: ASCII letters/digits + CJK Unified Ideographs)`
      );
    }
    displayName = `${repo}-${slug}`;
  } else if (resumeSid.length === 0) {
    displayName = `${repo}-${randSuffix()}`;
  }
  const name = `${SESSION_PREFIX}${repo}`;
  if (await sessionExists(name, env.runTmux)) {
    if (hasPrompt) {
      return die2(
        `${repo} already exists (tmux=${name}) \u2014 atomic bootstrap rejected because the teammate is already running. Use 'tm send ${repo} --prompt "\u2026"' to drive an existing teammate, or 'tm kill ${repo}' first to start over.`
      );
    }
    return {
      code: 0,
      stdout: `${repo} already exists (tmux=${name}; use 'tm status ${repo}' to view, or 'tm kill ${repo}' first)
`,
      stderr: ""
    };
  }
  const rf = readyFile(repo);
  rmSync3(rf, { force: true });
  const cf = cwdFile(repo);
  mkdirSync2(dirname(cf), { recursive: true });
  writeFileSync2(cf, `${cwdPhys}
`);
  let paneId = "";
  try {
    const newSession = await env.runTmux([
      "new-session",
      "-d",
      "-s",
      name,
      "-c",
      cwdPhys,
      "-e",
      `CLAUDEMUX_TEAMMATE_REPO=${repo}`,
      "-P",
      "-F",
      "#{session_id}"
    ]);
    if (newSession.code !== 0) {
      return die2(`tmux new-session failed: ${newSession.stderr.trim() || newSession.stdout.trim()}`);
    }
    paneId = newSession.stdout.split("\n")[0] ?? "";
  } catch (err) {
    return die2(`tmux new-session failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (paneId.length === 0) return die2(`tmux new-session returned no session id for ${repo}`);
  const sid = resumeSid.length > 0 ? resumeSid : newSid();
  const launchFlags = teammateLaunchFlags(mdExcludes);
  const nameArg = displayName.length > 0 ? ` -n ${shellSingleQuote(displayName)}` : "";
  const launchCmd = resumeSid.length > 0 ? `claude --resume ${sid} ${launchFlags}${nameArg}` : `claude --session-id ${sid} ${launchFlags}${nameArg}`;
  await env.runTmux(["send-keys", "-t", paneId, launchCmd, "Enter"]);
  let stderr = "";
  if (resumeSid.length > 0) {
    const nameNote = displayName.length > 0 ? `, name=${displayName}` : "";
    stderr += `spawned: ${repo} (tmux=${name}, cwd=${cwdPhys}, resumed sid=${sid}${nameNote})
`;
  } else {
    const nameNote = displayName.length > 0 ? `, name=${displayName}` : "";
    stderr += `spawned: ${repo} (tmux=${name}, cwd=${cwdPhys}, sid=${sid}${nameNote})
`;
  }
  const sf = sidFile(repo);
  mkdirSync2(dirname(sf), { recursive: true });
  writeFileSync2(sf, `${sid}
`);
  clearIdle(sid);
  if (resumeSid.length === 0) {
    mkdirSync2(idleDir(), { recursive: true });
    writeFileSync2(lastFileFor(sid), "");
  }
  const readyAfter = await pollReady(repo);
  if (readyAfter !== null) {
    stderr += `ready: ${repo} (tmux=${name}, SessionStart fired after ~${readyAfter} ms)
`;
  } else {
    stderr += `WARN: ${repo} (tmux=${name}) did not signal ready within 18s (no SessionStart hook fire \u2014 the plugin's on-session-start.sh may not be loaded, or claude failed to boot). Continuing, but if the REPL is actually dead, a subsequent sync 'tm send' / 'tm spawn --prompt' / 'tm compact' will block until its --timeout expires (default 1800s). 'tm status ${repo}' shows the live pane if you need to verify.
`;
  }
  if (!hasPrompt) {
    return { code: 0, stdout: "", stderr };
  }
  await sleepMs(3e3);
  const sendArgs = [];
  if (noWait) sendArgs.push("--no-wait");
  sendArgs.push(repo, "--prompt", prompt);
  const sendResult = await send(sendArgs, void 0, env);
  return {
    code: sendResult.code,
    stdout: sendResult.stdout,
    stderr: stderr + sendResult.stderr
  };
};
function parseSendArgs(args) {
  let noWait = false;
  let paneQuiet = false;
  let timeout = "1800";
  let repo = "";
  let prompt = "";
  let hasPrompt = false;
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--no-wait") {
      noWait = true;
      i++;
    } else if (arg === "--pane-quiet") {
      paneQuiet = true;
      i++;
    } else if (arg === "--timeout") {
      if (i + 1 >= args.length) return { error: die2("tm send: --timeout requires a value") };
      timeout = args[i + 1];
      i += 2;
    } else if (arg.startsWith("--timeout=")) {
      timeout = arg.slice("--timeout=".length);
      i++;
    } else if (arg === "--prompt") {
      if (i + 1 >= args.length) return { error: die2("tm send: --prompt requires a value") };
      prompt = args[i + 1];
      hasPrompt = true;
      i += 2;
    } else if (arg.startsWith("--prompt=")) {
      prompt = arg.slice("--prompt=".length);
      hasPrompt = true;
      i++;
    } else if (arg === "--") {
      i++;
      repo = args[i] ?? "";
      i++;
      break;
    } else if (arg.startsWith("-")) {
      return { error: die2(`tm send: unknown flag: ${arg}`) };
    } else if (repo === "") {
      repo = arg;
      i++;
    } else {
      const tail = args.slice(i).join(" ");
      return {
        error: die2(
          `tm send: prompt is now a --prompt flag, not a positional arg. Did you mean: tm send ${repo} --prompt ${shellSingleQuote(tail)} ?`
        )
      };
    }
  }
  return { repo, prompt, hasPrompt, noWait, paneQuiet, timeout };
}
var send = async (args, _options, env) => {
  const firstArg = args[0] ?? "";
  if (isCodexTarget(firstArg)) {
    const rest = args.slice(1);
    let prompt2 = null;
    let noWait2 = false;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === "--prompt") {
        if (i + 1 >= rest.length) return die2("tm send: --prompt requires a value");
        prompt2 = rest[i + 1] ?? "";
        i += 1;
      } else if (a === "--no-wait") {
        noWait2 = true;
      } else {
        return die2(
          `tm send: codex teammate '${firstArg}' does not yet accept '${a}' (stage 4 surface is '--prompt' and '--no-wait')`
        );
      }
    }
    if (prompt2 === null) return die2("tm send: missing --prompt");
    return codexSend(firstArg, prompt2, { noWait: noWait2 });
  }
  const parsed = parseSendArgs(args);
  if ("error" in parsed) return parsed.error;
  const { repo, prompt, hasPrompt, noWait, paneQuiet, timeout } = parsed;
  if (repo === "") {
    return die2(
      'tm send: missing <repo>. Usage: tm send <repo> --prompt "..." [--no-wait] [--pane-quiet] [--timeout N]'
    );
  }
  if (!hasPrompt) {
    return die2(
      'tm send: missing --prompt. Usage: tm send <repo> --prompt "..." [--no-wait] [--pane-quiet] [--timeout N]'
    );
  }
  if (!isNonNegativeInteger(timeout)) {
    return die2(`tm send: --timeout must be a non-negative integer (got: '${timeout}')`);
  }
  const sentResult = await sendKeys(repo, prompt, env);
  if (sentResult.code !== 0) return sentResult;
  if (noWait) return sentResult;
  const timeoutSec = Number(timeout);
  const verdict = paneQuiet ? await waitPaneQuiet(repo, timeoutSec, env) : await waitIdleSignal(repo, timeoutSec, false, env);
  if ("code" in verdict) return verdict;
  if (!verdict.ok) {
    const kind = paneQuiet ? "pane-quiet" : "Stop hook";
    return {
      code: 1,
      stdout: printLastOrEmpty(repo),
      stderr: sentResult.stderr + `tm send: timed out after ${timeout}s waiting for ${kind} on ${repo}
`
    };
  }
  let trailingStderr = "";
  if (!paneQuiet) trailingStderr = echoCtxToStderr(repo, env);
  return {
    code: 0,
    stdout: printLastOrEmpty(repo),
    stderr: sentResult.stderr + trailingStderr
  };
};
function parseWaitArgs(args) {
  const SILENT = { code: 1, stdout: "", stderr: "" };
  let repo = "";
  let timeout = "1800";
  let fresh = false;
  let paneQuiet = false;
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--fresh") {
      fresh = true;
      i++;
    } else if (arg === "--pane-quiet") {
      paneQuiet = true;
      i++;
    } else if (arg === "--timeout") {
      if (i + 1 >= args.length) return { error: SILENT };
      timeout = args[i + 1];
      i += 2;
    } else if (arg.startsWith("--timeout=")) {
      timeout = arg.slice("--timeout=".length);
      i++;
    } else if (arg.startsWith("-")) {
      return { error: die2(`tm wait: unknown flag: ${arg}`) };
    } else if (repo === "") {
      repo = arg;
      i++;
    } else {
      timeout = arg;
      i++;
    }
  }
  return { repo, timeout, fresh, paneQuiet };
}
var wait = async (args, _options, env) => {
  const firstArg = args[0] ?? "";
  if (isCodexTarget(firstArg)) {
    const rest = args.slice(1);
    if (rest.length > 0) {
      return die2(
        `tm wait: codex teammate '${firstArg}' takes no additional arguments yet (stage 4 surface is just 'tm wait ${firstArg}')`
      );
    }
    return codexWait(firstArg);
  }
  const parsed = parseWaitArgs(args);
  if ("error" in parsed) return parsed.error;
  const { repo, timeout, fresh, paneQuiet } = parsed;
  if (repo === "") {
    return die2(
      "usage: tm wait <repo> [timeout=1800] [--fresh] [--pane-quiet] [--timeout N]"
    );
  }
  if (!isNonNegativeInteger(timeout)) {
    return die2(`tm wait: --timeout must be a non-negative integer (got: '${timeout}')`);
  }
  const timeoutSec = Number(timeout);
  const verdict = paneQuiet ? await waitPaneQuiet(repo, timeoutSec, env) : await waitIdleSignal(repo, timeoutSec, fresh, env);
  if ("code" in verdict) return verdict;
  if (!verdict.ok) {
    return {
      code: 1,
      stdout: printLastOrEmpty(repo),
      stderr: `tm wait: timed out after ${timeout}s on ${repo}
`
    };
  }
  let trailingStderr = "";
  if (!paneQuiet) trailingStderr = echoCtxToStderr(repo, env);
  return {
    code: 0,
    stdout: printLastOrEmpty(repo),
    stderr: trailingStderr
  };
};
function parseCompactArgs(args) {
  const SILENT = { code: 1, stdout: "", stderr: "" };
  let repo = "";
  let timeout = "1800";
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--timeout") {
      if (i + 1 >= args.length) return { error: SILENT };
      timeout = args[i + 1];
      i += 2;
    } else if (arg.startsWith("--timeout=")) {
      timeout = arg.slice("--timeout=".length);
      i++;
    } else if (arg.startsWith("-")) {
      return { error: die2(`tm compact: unknown flag: ${arg}`) };
    } else if (repo === "") {
      repo = arg;
      i++;
    } else {
      timeout = arg;
      i++;
    }
  }
  return { repo, timeout };
}
var COMPACT_REFUSAL_MARK = "\u23BF  Error: Not enough messages to compact";
var compact = async (args, _options, env) => {
  const parsed = parseCompactArgs(args);
  if ("error" in parsed) return parsed.error;
  const { repo, timeout } = parsed;
  if (repo === "") return die2("usage: tm compact <repo> [timeout=1800] [--timeout N]");
  if (!isNonNegativeInteger(timeout)) {
    return die2(`tm compact: --timeout must be a non-negative integer (got: '${timeout}')`);
  }
  const sessionMissing = await requireSession(repo, env.runTmux);
  if (sessionMissing !== null) return sessionMissing;
  const sidR = resolveSidOrDie(repo);
  if ("error" in sidR) return sidR.error;
  const sid = sidR.sid;
  const pane = await resolvePaneTarget(repo, env.runTmux);
  if (pane === "") return die2(`could not resolve pane target for ${repo}`);
  let stderr = `tm compact: sending /compact to ${repo} (sid=${sid}, timeout=${timeout}s)
`;
  const sent = await sendKeys(repo, "/compact", env);
  stderr += sent.stderr;
  if (sent.code !== 0) {
    return { code: sent.code, stdout: sent.stdout, stderr };
  }
  const timeoutSec = Number(timeout);
  const end = nowSec2() + timeoutSec;
  const marker = idleMarkerFor(sid);
  while (nowSec2() < end) {
    if (existsSync2(marker)) {
      return { code: 0, stdout: "compacted\n", stderr };
    }
    if (pane.length > 0) {
      try {
        const captured = await env.runTmux(["capture-pane", "-t", pane, "-p"]);
        if (captured.code === 0 && captured.stdout.includes(COMPACT_REFUSAL_MARK)) {
          return {
            code: 1,
            stdout: "",
            stderr: stderr + `tm compact: ${repo} refused /compact \u2014 Claude Code reported 'Not enough messages to compact' (transcript too short).
`
          };
        }
      } catch {
      }
    }
    await sleepMs(3e3);
  }
  return {
    code: 1,
    stdout: "",
    stderr: stderr + `tm compact: ${repo} did not signal PostCompact within ${timeout}s \u2014 compaction may still be running, or the Stop hook is misconfigured. Check 'tm status ${repo}' and ${marker}.
`
  };
};
function parseResumeArgs(args) {
  const SILENT = { code: 1, stdout: "", stderr: "" };
  let repo = "";
  let sid = "";
  let task = "";
  let prompt = "";
  let hasPrompt = false;
  let noWait = false;
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--prompt") {
      if (i + 1 >= args.length) return { error: die2("tm resume: --prompt requires a value") };
      prompt = args[i + 1];
      hasPrompt = true;
      i += 2;
    } else if (arg.startsWith("--prompt=")) {
      prompt = arg.slice("--prompt=".length);
      hasPrompt = true;
      i++;
    } else if (arg === "--task") {
      if (i + 1 >= args.length) return { error: SILENT };
      task = args[i + 1];
      i += 2;
    } else if (arg.startsWith("--task=")) {
      task = arg.slice("--task=".length);
      i++;
    } else if (arg === "--no-wait") {
      noWait = true;
      i++;
    } else if (arg === "--") {
      i++;
      break;
    } else if (arg.startsWith("-")) {
      return { error: die2(`unknown flag: ${arg}`) };
    } else if (repo === "") {
      repo = arg;
      i++;
    } else if (sid === "") {
      sid = arg;
      i++;
    } else {
      return {
        error: die2(
          `tm resume: too many positional args (got '${arg}' after repo='${repo}' sid='${sid}')`
        )
      };
    }
  }
  return { repo, sid, task, prompt, hasPrompt, noWait };
}
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
var resume = async (args, _options, env) => {
  const parsed = parseResumeArgs(args);
  if ("error" in parsed) return parsed.error;
  let { sid } = parsed;
  const { repo, task, prompt, hasPrompt, noWait } = parsed;
  if (repo === "") {
    return die2(
      'usage: tm resume <repo> [<sid>] [--task <slug>] [--prompt "..."] [--no-wait]  (sid from ledger preferred; auto-pick on omit; --task relabels the resumed conversation; --no-wait only with --prompt)'
    );
  }
  if (noWait && !hasPrompt) {
    return die2("tm resume: --no-wait is only valid with --prompt");
  }
  const path = join3(env.dispatcherDir, repo);
  if (!isDirectory(path)) return dieRepoNotFound("resume", repo, path, env.dispatcherDir);
  const name = `${SESSION_PREFIX}${repo}`;
  if (await sessionExists(name, env.runTmux)) {
    return die2(
      `${repo} already running (tmux=${name}) \u2014 'tm kill ${repo}' first if you really want to start over`
    );
  }
  const projectDir = projectDirForRepo(repo, env);
  let autoPickStderr = "";
  if (sid === "") {
    if (!isDirectory(projectDir)) {
      return die2(
        `no project dir at ${projectDir} \u2014 has anyone ever run claude inside ${path}? Try 'tm spawn ${repo}' first.`
      );
    }
    let names = [];
    try {
      names = readdirSync2(projectDir).filter((file) => file.endsWith(".jsonl"));
    } catch {
      names = [];
    }
    if (names.length === 0) {
      return die2(`no .jsonl transcripts under ${projectDir} \u2014 try 'tm spawn ${repo}' to start fresh.`);
    }
    const stats = names.map((file) => {
      let mtime = 0;
      try {
        mtime = Math.floor(statSync2(join3(projectDir, file)).mtimeMs / 1e3);
      } catch {
        mtime = 0;
      }
      return { file, mtime };
    });
    stats.sort((a, b) => b.mtime - a.mtime || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    const latest = stats[0];
    sid = latest.file.replace(/\.jsonl$/, "");
    autoPickStderr = `tm resume: no sid given \u2014 auto-picked ${sid} (jsonl mtime ${fmtLocalDateTime(latest.mtime)}). Prefer passing the sid from your task ledger.
`;
  } else {
    const target = join3(projectDir, `${sid}.jsonl`);
    if (!isRegularFile(target)) {
      return die2(
        `no transcript at ${target} \u2014 wrong repo for this sid, or sid does not exist. Check 'ls ${projectDir}/'.`
      );
    }
  }
  if (!UUID_RE.test(sid)) return die2(`sid is not a valid uuid: ${sid}`);
  const spawnArgs = [repo, "--resume", sid];
  if (task.length > 0) {
    spawnArgs.push("--task", task);
  }
  if (hasPrompt) {
    if (noWait) spawnArgs.push("--no-wait");
    spawnArgs.push("--prompt", prompt);
  }
  const result = await spawn2(spawnArgs, void 0, env);
  return {
    code: result.code,
    stdout: result.stdout,
    stderr: autoPickStderr + result.stderr
  };
};
var ask = async (args, _options, _env) => {
  if (args.length === 0) {
    return die2('usage: tm ask "<prompt>"');
  }
  if (args.length > 1) {
    return die2(
      `tm ask: takes exactly one positional argument (the prompt) \u2014 got ${args.length}`
    );
  }
  return codexAsk(args[0] ?? "");
};
var NATIVE_VERBS = {
  ls,
  last,
  ctx,
  states,
  mem,
  history,
  status,
  poll,
  kill,
  archive,
  reload,
  doctor,
  spawn: spawn2,
  send,
  wait,
  compact,
  resume,
  ask
};

// src/tmux.ts
function resolveTmuxBinary() {
  const override = process.env.CLAUDEMUX_TMUX;
  if (override && override.length > 0) return override;
  return "tmux";
}
var runTmux = (args, options) => spawnCapture([resolveTmuxBinary(), ...args], options);

// src/cli.ts
import { homedir } from "node:os";
import { join as join4 } from "node:path";
function triggersHelp(args) {
  for (const arg of args) {
    if (arg === "-h" || arg === "--help") return true;
    if (arg === "--prompt" || arg.startsWith("--prompt=")) return false;
    if (!arg.startsWith("-")) return false;
  }
  return false;
}
function removedVerb(message) {
  return { code: 2, stdout: "", stderr: message };
}
function unknownVerb(verb) {
  return {
    code: 1,
    stdout: OVERVIEW_HELP,
    stderr: `tm: unknown subcommand: ${verb}
`
  };
}
function runHelpVerb(rest) {
  const target = rest[0];
  if (target === void 0) return { code: 0, stdout: OVERVIEW_HELP, stderr: "" };
  if (target === "help" || target === "-h" || target === "--help") {
    return { code: 0, stdout: OVERVIEW_HELP, stderr: "" };
  }
  if (Object.hasOwn(HELP_TEXTS, target)) {
    return { code: 0, stdout: HELP_TEXTS[target], stderr: "" };
  }
  return {
    code: 1,
    stdout: OVERVIEW_HELP,
    stderr: `tm: no help for unknown verb: ${target}
`
  };
}
async function runCli(argv, env, stdin) {
  const [verb, ...rest] = argv;
  if (verb === void 0 || verb === "") {
    return { code: 0, stdout: OVERVIEW_HELP, stderr: "" };
  }
  if (verb === "help" || verb === "-h" || verb === "--help") {
    return runHelpVerb(rest);
  }
  if (triggersHelp(rest)) {
    const text = Object.hasOwn(HELP_TEXTS, verb) ? HELP_TEXTS[verb] : OVERVIEW_HELP;
    return { code: 0, stdout: text, stderr: "" };
  }
  if (Object.hasOwn(REMOVED_VERB_MESSAGES, verb)) {
    return removedVerb(REMOVED_VERB_MESSAGES[verb]);
  }
  if (Object.hasOwn(NATIVE_VERBS, verb)) {
    const handler = NATIVE_VERBS[verb];
    const options = stdin != null ? { stdin } : void 0;
    return handler(rest, options, env);
  }
  return unknownVerb(verb);
}
function productionEnv() {
  return {
    runTmux,
    runColumn,
    runGrep,
    // `tm` resolves the dispatcher dir from `TM_DISPATCHER_DIR` or `$PWD`
    // (bash's `${TM_DISPATCHER_DIR:-$PWD}`). Two semantics matter here:
    //   - `$PWD` is the *logical* cwd, preserving the symlink the user
    //     `cd`'d through; Node's `process.cwd()` would return the
    //     symlink-resolved physical path, and `~/.claude/projects` lookups
    //     would diverge between bash and native on a symlinked dispatcher
    //     tree.
    //   - bash `${VAR:-default}` triggers the default on *unset* OR *empty*,
    //     so `||` (which treats empty strings as falsy) is the right
    //     operator — `??` would let an accidentally-empty
    //     `TM_DISPATCHER_DIR` through and resolve `<repo>` paths against
    //     `""`, while `tm doctor`'s own check treats empty as unset and
    //     reports the opposite of what the verbs saw.
    dispatcherDir: process.env.TM_DISPATCHER_DIR || process.env.PWD || process.cwd(),
    projectsDir: join4(process.env.HOME ?? homedir(), ".claude", "projects")
  };
}

// src/main.ts
async function readStdin() {
  if (process.stdin.isTTY) return void 0;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
async function main() {
  const argv = process.argv.slice(2);
  const needsStdin = argv[0] === "archive" && !triggersHelp(argv.slice(1));
  const stdin = needsStdin ? await readStdin() : void 0;
  const result = await runCli(argv, productionEnv(), stdin);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
main().catch((err) => {
  process.stderr.write(`[tm] ${err instanceof Error ? err.message : String(err)}
`);
  process.exitCode = 1;
});
