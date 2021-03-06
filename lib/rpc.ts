/**
 * Rpc implements an remote-procedure-call interface on top of a simple messaging interface.
 *
 * The user must provide the messaging between two endpoints, and in return gets the ability to
 * register interfaces or functions at either endpoint, and call them from the other side. For
 * messaging, the user must supply a sendMessage() function to send messages to the other side,
 * and must call rpc.receiveMessage(msg) whenever a message is received.
 *
 * E.g.
 *    rpc.registerImpl<MyInterface>("some-name", new MyInterfaceImpl(), descMyInterfaceImpl);
 *    rpc.getStub<MyInterface>("some-name", descMyInterfaceImpl)
 *          => returns a stub implemeting MyInterface
 *
 * Calls to the generated stub get turned into messages across the channel, and then call to the
 * implementation object registered on the other side. Both return values and exceptions get
 * passed back over the channel, and cause the promise from the stub to be resolved or rejected.
 *
 * Note that the stub interface returns Promises for all methods.
 *
 * Rpc library supports ts-interface-checker descriptors for the interfaces, to allow validation.
 * You may skip it by passing in `rpc.unchecked` where a descriptor is expected; it will skip
 * checks and you will not get descriptive errors.
 *
 * The string name used to register and use an implementation allows for the same Rpc object to be
 * used to expose multiple interfaces, or different implementations of the same interface.
 *
 * Messaging
 * ---------
 * Rpc also supports a messaging interface, with postMessage() to send arbitrary messages, and an
 * EventEmitter interface for "message" events to receive them, e.g. on("message", ...). So if you
 * need to multiplex non-Rpc messages over the same channel, Rpc class does it for you.
 *
 * Cleanup
 * -------
 * If the channel is closed or had an error, and will no longer be used, the user of Rpc must
 * call rpc.close() to reject any calls waiting for an answer.
 *
 * If a particular stub for a remote API is no longer needed, user may call rpc.discardStub(stub)
 * to reject any pending calls made to that stub.
 *
 * Timeouts
 * --------
 * TODO (Not yet implementd.)
 * You may call rpc.setTimeout(ms) or rpc.setStubTimeout(stub, ms) to set a call timeout for all
 * stubs or for a particular one. If a response to a call does not arrive within the timeout, the
 * call gets rejected, and the rejection Error will have a "code" property set to "TIMEOUT".
 *
 * Forwarding
 * ----------
 * Rpc.registerForwarder() along with methods with "-Forward" suffix allow one Rpc object to forward
 * calls and messages to another Rpc object. The intended usage is when Rpc connects A to B, and B
 * to C. Then B can use registerForwarder to expose A's interfaces to C (or C's to A) without having
 * to know what exactly they are. A default forwarder can be registered using the '*' name.
 *
 *
 * Instead of using getStubForward and callRemoteFuncForward, the forwarder name can be
 * appended to the interface name as "interfaceName@forwarderName" and the regular
 * getStub and callRemoteFunc methods can be used.  For example:
 *   getStub("iface@forwarder")
 * is the same as:
 *   getStubForward("forwarder", "iface")
 *
 *
 * E.g. with A.registerImpl("A-name", ...) and B.registerForwarder("b2a", A), we may now call
 * C.getStubForward("b2a", "A-name") to get a stub that will forward calls to A, as well as
 * C.postMessageForward("b2a", msg) to have the message received by A.
 *
 * TODO We may want to support progress callbacks, perhaps by supporting arbitrary callbacks as
 * parameters. (Could be implemented by allowing "meth" to be [reqId, paramPath]) It would be nice
 * to allow the channel to report progress too, e.g. to report progress of uploading large files.
 *
 * TODO Sending of large files should probably be a separate feature, to allow for channel
 * implementations to stream them.
 */
import {EventEmitter} from "events";
import * as tic from "ts-interface-checker";
import {IMessage, IMsgCustom, IMsgRpcCall, IMsgRpcRespData, IMsgRpcRespErr, MsgType} from "./message";

export type SendMessageCB = (msg: IMessage) => Promise<void> | void;

interface IForwardingName {
  forwarder: string;
  name: string;
}

export interface IForwarderDest {
  forwardCall: (c: IMsgRpcCall) => Promise<any>;
  forwardMessage: (msg: IMsgCustom) => Promise<any>;
}

export type ICallWrapper = (callFunc: () => Promise<any>) => Promise<any>;

const plainCall: ICallWrapper = (callFunc) => callFunc();

export class Rpc extends EventEmitter implements IForwarderDest {
  // Note the invariant: _inactiveSendQueue == null iff (_sendMessageCB != null && !_waitForReadyMessage)
  private _sendMessageCB: SendMessageCB|null = null;
  private _inactiveRecvQueue: IMessage[]|null = null;  // queue of received message
  private _inactiveSendQueue: IMessage[]|null = null;  // queue of messages to be sent
  private _waitForReadyMessage = false;
  private _logger: IRpcLogger;
  private _callWrapper: ICallWrapper;
  private _implMap: Map<string, Implementation> = new Map();
  private _forwarders: Map<string, ImplementationFwd> = new Map();
  private _pendingCalls: Map<number, ICallObj> = new Map();
  private _nextRequestId = 1;

  /**
   * To use Rpc, you must provide a sendMessage function that sends a message to the other side;
   * it may be given in the constructor, or later with setSendMessage. You must also call
   * receiveMessage() for every message received from the other side.
   */
  constructor(options: {logger?: IRpcLogger, sendMessage?: SendMessageCB,
                        callWrapper?: ICallWrapper} = {}) {
    super();
    const {logger = console, sendMessage = null, callWrapper = plainCall} = options;
    this._logger = logger;
    this._callWrapper = callWrapper;
    this.setSendMessage(sendMessage);
  }

  /**
   * To use Rpc, call this for every message received from the other side of the channel.
   */
  public receiveMessage(msg: IMessage): void {
    if (this._inactiveRecvQueue) {
      this._inactiveRecvQueue.push(msg);
    } else {
      this._dispatch(msg);
    }
  }

  /**
   * If you've set up calls to receiveMessage(), but need time to call registerImpl() before
   * processing new messages, you may use queueIncoming(), make the registerImpl() calls,
   * and then call processIncoming() to handle queued messages and resume normal processing.
   */
  public queueIncoming() {
    if (!this._inactiveRecvQueue) {
      this._inactiveRecvQueue = [];
    }
  }

  /**
   * Process received messages queued since queueIncoming, and resume normal processing of
   * received messages.
   */
  public processIncoming() {
    if (this._inactiveRecvQueue) {
      processQueue(this._inactiveRecvQueue, this._dispatch.bind(this));
      this._inactiveRecvQueue = null;
    }
  }

  /**
   * Set the callback to send messages. If set to null, sent messages will be queued. If you
   * disconnect and want for sent messages to throw, set a callback that throws.
   */
  public setSendMessage(sendMessage: SendMessageCB|null) {
    this._sendMessageCB = sendMessage;
    if (this._sendMessageCB) {
      this._processOutgoing();
    } else {
      this._queueOutgoing();
    }
  }

  /**
   * If your peer may not be listening yet to your messages, you may call this to queue outgoing
   * messages until receiving a "ready" message from the peer. I.e. one peer may call
   * queueOutgoingUntilReadyMessage() while the other calls sendReadyMessage().
   */
  public queueOutgoingUntilReadyMessage() {
    this._waitForReadyMessage = true;
    this._queueOutgoing();
  }

  /**
   * If your peer is using queueOutgoingUntilReadyMessage(), you should let it know that you are
   * ready using sendReadyMessage() as soon as you've set up the processing of received messages.
   * Note that at most one peer may use queueOutgoingUntilReadyMessage(), or they will deadlock.
   */
  public sendReadyMessage() {
    return this._sendMessage({mtype: MsgType.Ready});
  }

  /**
   * Messaging interface: send data to the other side, to be emitted there as a "message" event.
   */
  public postMessage(data: any): Promise<void> { return this.postMessageForward("", data); }

  public async postMessageForward(fwdDest: string, data: any): Promise<void> {
    const msg: IMsgCustom = {mtype: MsgType.Custom, data};
    if (fwdDest) { msg.mdest = fwdDest; }
    await this._sendMessage(msg);
  }

  /**
   * Registers a new implementation under the given name. It is an error if this name is already
   * in use. To skip all validation, use `registerImpl<any>(...)` and omit the last argument.
   * TODO Check that registerImpl without a type param requires a checker.
   */
  public registerImpl<Iface extends any>(name: string, impl: any): void;
  public registerImpl<Iface>(name: string, impl: Iface, checker: tic.Checker): void;
  public registerImpl(name: string, impl: any, checker?: tic.Checker): void {
    if (this._implMap.has(name)) {
      throw new Error(`Rpc.registerImpl has already been called for ${name}`);
    }
    const invokeImpl = (call: IMsgRpcCall) => impl[call.meth](...call.args);
    if (!checker) {
      this._implMap.set(name, {name, invokeImpl, argsCheckers: null});
    } else {
      const ttype = checker.getType();
      if (!(ttype instanceof tic.TIface)) {
        throw new Error("Rpc.registerImpl requires a Checker for an interface");
      }
      const argsCheckers: {[name: string]: tic.Checker} = {};
      for (const prop of ttype.props) {
        if (prop.ttype instanceof tic.TFunc) {
          argsCheckers[prop.name] = checker.methodArgs(prop.name);
        }
      }
      this._implMap.set(name, {name, invokeImpl, argsCheckers});
    }
  }

  public registerForwarder(fwdName: string, dest: IForwarderDest,
                           fwdDest: string = (fwdName === "*" ? "*" : "")): void {
    const passThru = fwdDest === "*";
    this._forwarders.set(fwdName, {
      name: "[FWD]" + fwdName,
      argsCheckers: null,
      invokeImpl: (c: IMsgRpcCall) => dest.forwardCall({...c, mdest: passThru ? c.mdest : fwdDest}),
      forwardMessage: (msg: IMsgCustom) => dest.forwardMessage({...msg, mdest: passThru ? msg.mdest : fwdDest}),
    });
  }

  public unregisterForwarder(fwdName: string): void {
    this._forwarders.delete(fwdName);
  }

  /**
   * Unregister an implementation, if one was registered with this name.
   */
  public unregisterImpl(name: string): void {
    this._implMap.delete(name);
  }

  /**
   * Creates a local stub for the given remote interface. The stub implements Iface, forwarding
   * calls to the remote implementation, each one returning a Promise for the received result.
   * To skip all validation, use `any` for the type and omit the last argument.
   *
   * Interface names can be followed by a "@<forwarder>" part
   */
  public getStub<Iface extends any>(name: string): Iface;
  public getStub<Iface>(name: string, checker: tic.Checker): Iface;
  public getStub<Iface>(name: string, checker?: tic.Checker): Iface {
    const parts = this._parseName(name);
    return this.getStubForward(parts.forwarder, parts.name, checker!);
  }

  public getStubForward<Iface extends any>(fwdDest: string, name: string): any;
  public getStubForward<Iface>(fwdDest: string, name: string, checker: tic.Checker): Iface;
  public getStubForward(fwdDest: string, name: string, checker?: tic.Checker): any {
    if (!checker) {
      // TODO Test, then explain how this works.
      return new Proxy({}, {
        get: (target, property: string, receiver) => {
          if (property === "then") {
            // By default, take care not to look "thenable", so that the stub can be returned
            // as a value of a Promise:
            // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/resolve
            // If user really wants to proxy "then", they can write a checker.
            return undefined;
          }
          return (...args: any[]) => this._makeCall(name, property, args, anyChecker, fwdDest);
        },
      });
    } else {
      const ttype = checker.getType();
      if (!(ttype instanceof tic.TIface)) {
        throw new Error("Rpc.getStub requires a Checker for an interface");
      }
      const api: any = {};
      for (const prop of ttype.props) {
        if (prop.ttype instanceof tic.TFunc) {
          const resultChecker = checker.methodResult(prop.name);
          api[prop.name] = (...args: any[]) => this._makeCall(name, prop.name, args, resultChecker, fwdDest);
        }
      }
      return api;
    }
  }

  /**
   * Simple way to registers a function under a given name, with no argument checking.
   */
  public registerFunc(name: string, impl: (...args: any[]) => any): void {
    return this.registerImpl<IAnyFunc>(name, {invoke: impl}, checkerAnyFunc);
  }

  /**
   * Unregister a function, if one was registered with this name.
   */
  public unregisterFunc(name: string): void {
    return this.unregisterImpl(name);
  }

  /**
   * Call a remote function registered with registerFunc. Does no type checking.
   */
  public callRemoteFunc(name: string, ...args: any[]): Promise<any> {
    const parts = this._parseName(name);
    return this.callRemoteFuncForward(parts.forwarder, parts.name, ...args);
  }

  public callRemoteFuncForward(fwdDest: string, name: string, ...args: any[]): Promise<any> {
    return this._makeCall(name, "invoke", args, anyChecker, fwdDest);
  }

  public forwardCall(c: IMsgRpcCall): Promise<any> {
    return this._makeCall(c.iface, c.meth, c.args, anyChecker, c.mdest || "");
  }

  public forwardMessage(msg: IMsgCustom): Promise<any> {
    return this.postMessageForward(msg.mdest || "", msg.data);
  }

  // Mark outgoing messages for queueing.
  private _queueOutgoing() {
    if (!this._inactiveSendQueue) {
      this._inactiveSendQueue = [];
    }
  }

  // If sendMessageCB is set and we are no longer waiting for a ready message, send out any
  // queued outgoing messages and resume normal sending.
  private _processOutgoing() {
    if (this._inactiveSendQueue && this._sendMessageCB && !this._waitForReadyMessage) {
      processQueue(this._inactiveSendQueue, this._sendMessageOrReject.bind(this, this._sendMessageCB));
      this._inactiveSendQueue = null;
    }
  }

  private _sendMessage(msg: IMessage): Promise<void> | void {
    if (this._inactiveSendQueue) {
      this._inactiveSendQueue.push(msg);
    } else {
      return this._sendMessageOrReject(this._sendMessageCB!, msg);
    }
  }

  // This helper calls calls sendMessage(msg), and if that call fails, rejects the call
  // represented by msg (when it's of type RpcCall).
  private _sendMessageOrReject(sendMessage: SendMessageCB, msg: IMessage): Promise<void> | void {
    if (this._logger.info) {
      const desc = (msg.mtype === MsgType.RpcCall) ? ": " + this._callDesc(msg) : "";
      this._logger.info(`Rpc sending ${MsgType[msg.mtype]}${desc}`);
    }
    return catchMaybePromise(() => sendMessage(msg), (err) => this._sendReject(msg, err));
  }

  // Rejects a RpcCall due to the given send error; this helper always re-throws.
  private _sendReject(msg: IMessage, err: Error) {
    const newErr = new ErrorWithCode("RPC_SEND_FAILED", `Send failed: ${err.message}`);
    if (msg.mtype === MsgType.RpcCall && msg.reqId !== undefined) {
      const callObj = this._pendingCalls.get(msg.reqId);
      if (callObj) {
        this._pendingCalls.delete(msg.reqId);
        callObj.reject(newErr);
      }
    }
    this.emit("error", newErr);
    throw newErr;
  }

  private _makeCallRaw(iface: string, meth: string, args: any[], resultChecker: tic.Checker,
                       fwdDest: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const reqId = this._nextRequestId++;
      const callObj: ICallObj = {reqId, iface, meth, resolve, reject, resultChecker};
      this._pendingCalls.set(reqId, callObj);

      // Send the Call message. If the sending fails, reject the _makeCall promise. If it
      // succeeds, we save {resolve,reject} to resolve _makeCall when we get back a response.
      this._info(callObj, "RPC_CALLING");
      const msg: IMsgRpcCall = {mtype: MsgType.RpcCall, reqId, iface, meth, args};
      if (fwdDest) { msg.mdest = fwdDest; }

      // If _sendMessage fails, reject, allowing it to throw synchronously or not.
      catchMaybePromise(() => this._sendMessage(msg), reject);
    });
  }

  private _makeCall(iface: string, meth: string, args: any[], resultChecker: tic.Checker,
                    fwdDest: string): Promise<any> {
    return this._callWrapper(() => this._makeCallRaw(iface, meth, args, resultChecker, fwdDest));
  }

  private _dispatch(msg: IMessage): void {
    switch (msg.mtype) {
      case MsgType.RpcCall: { this._onMessageCall(msg); return; }
      case MsgType.RpcRespData:
      case MsgType.RpcRespErr: { this._onMessageResp(msg); return; }
      case MsgType.Custom: { this._onCustomMessage(msg); return; }
      case MsgType.Ready: {
        this._waitForReadyMessage = false;
        try { this._processOutgoing(); } catch (e) { /* swallowing error, an event 'error' was already emitted */ }
        return;
      }
    }
  }

  private _onCustomMessage(msg: IMsgCustom): void {
    if (msg.mdest) {
      const impl = this._forwarders.get(msg.mdest) || this._forwarders.get("*");
      if (!impl) {
        this._warn(null, "RPC_UNKNOWN_FORWARD_DEST", "Unknown forward destination");
      } else {
        impl.forwardMessage(msg);
      }
    } else {
      this.emit("message", msg.data);
    }
  }

  private async _onMessageCall(call: IMsgRpcCall): Promise<void> {
    let impl: Implementation|undefined;
    if (call.mdest) {
      impl = this._forwarders.get(call.mdest) || this._forwarders.get("*");
      if (!impl) {
        return this._failCall(call, "RPC_UNKNOWN_FORWARD_DEST", "Unknown forward destination");
      }
    } else {
      impl = this._implMap.get(call.iface);
      if (!impl) {
        return this._failCall(call, "RPC_UNKNOWN_INTERFACE", "Unknown interface");
      }
    }

    if (!impl.argsCheckers) {
      // No call or argument checking.
    } else {
      // Check the method name and argument types.
      if (!impl.argsCheckers.hasOwnProperty(call.meth)) {
        return this._failCall(call, "RPC_UNKNOWN_METHOD", "Unknown method");
      }
      const argsChecker: tic.Checker = impl.argsCheckers[call.meth];
      try {
        argsChecker.check(call.args);
      } catch (e) {
        return this._failCall(call, "RPC_INVALID_ARGS", `Invalid args: ${e.message}`);
      }
    }

    if (call.reqId === undefined) {
      return this._failCall(call, "RPC_MISSING_REQID", "Missing request id");
    }
    this._info(call, "RPC_ONCALL");
    let result;
    try {
      result = await impl.invokeImpl(call);
    } catch (e) {
      return this._failCall(call, e.code, e.message, "RPC_ONCALL_ERROR");
    }
    this._info(call, "RPC_ONCALL_OK");
    return this._sendResponse(call.reqId, result);
  }

  private async _failCall(call: IMsgRpcCall, code: string, mesg: string, reportCode?: string): Promise<void> {
    this._warn(call, reportCode || code, mesg);
    if (call.reqId !== undefined) {
      const msg: IMsgRpcRespErr = {mtype: MsgType.RpcRespErr, reqId: call.reqId, mesg, code};
      await this._sendMessage(msg);
    }
  }

  private async _sendResponse(reqId: number, data: any): Promise<void> {
    const msg: IMsgRpcRespData = {mtype: MsgType.RpcRespData, reqId, data};
    await this._sendMessage(msg);
  }

  private _onMessageResp(resp: IMsgRpcRespData|IMsgRpcRespErr): void {
    const callObj = this._pendingCalls.get(resp.reqId);
    this._pendingCalls.delete(resp.reqId);
    if (!callObj) {
      this._warn(null, "RPC_UNKNOWN_REQID", `Response to unknown reqId ${resp.reqId}`);
      return;
    }
    if (resp.mtype === MsgType.RpcRespErr) {
      this._info(callObj, "RPC_RESULT_ERROR", resp.mesg);
      return callObj.reject(new ErrorWithCode(resp.code, resp.mesg));
    }
    try {
      callObj.resultChecker.check(resp.data);
    } catch (e) {
      this._warn(callObj, "RPC_RESULT_INVALID", e.message);
      return callObj.reject(new ErrorWithCode("RPC_INVALID_RESULT",
        `Implementation produced invalid result: ${e.message}`));
    }
    this._info(callObj, "RPC_RESULT_OK");
    callObj.resolve(resp.data);
  }

  private _info(call: IMsgRpcCall|ICallObj|null, code: string, message?: string): void {
    if (this._logger.info) {
      const msg = message ? " " + message : "";
      this._logger.info(`Rpc for ${this._callDesc(call)}: ${code}${msg}`);
    }
  }
  private _warn(call: IMsgRpcCall|ICallObj|null, code: string, message?: string): void {
    if (this._logger.warn) {
      const msg = message ? " " + message : "";
      this._logger.warn(`Rpc for ${this._callDesc(call)}: ${code}${msg}`);
    }
  }

  private _callDesc(call: IMsgRpcCall|ICallObj|null): string {
    if (!call) { return "?"; }
    return `${call.iface}.${call.meth}#${call.reqId || "-"}`;
  }

  private _parseName(name: string): IForwardingName {
    const idx = name.lastIndexOf("@");
    if (idx === -1) {
      return {
        forwarder: "",
        name,
      };
    }
    return {
      name: name.substr(0, idx),
      forwarder: name.substr(idx + 1),
    };
  }
}

interface Implementation {
  name: string;
  invokeImpl: (call: IMsgRpcCall) => Promise<any>;
  argsCheckers: null | {
    [name: string]: tic.Checker;
  };
}

interface ImplementationFwd extends Implementation {
  forwardMessage: (msg: IMsgCustom) => Promise<void>;
}

interface ICallObj {
  reqId: number;
  iface: string;
  meth: string;
  resultChecker: tic.Checker;
  resolve(data: any): void;
  reject(reason: ErrorWithCode): void;
}

/**
 * Interfaces may throw errors that include .code field, and it gets propagated to callers (e.g.
 * "NOT_AUTHORIZED"). Its purpose is to be a stable way to distinguish different types of errors.
 * This way the human-friendly error message can be changed without affecting behavior.
 */
export class ErrorWithCode extends Error {
  constructor(public code: string|undefined, message: string) {
    super(message);
  }
}

/**
 * Rpc logs everything to the passed-in logger, which is by default the console, but you may
 * provide your own.
 */
export interface IRpcLogger {
  info?(message: string): void;
  warn?(message: string): void;
}

interface IAnyFunc {
  invoke(): any;
}
const IAnyFunc = tic.iface([], {
  invoke: tic.func("any"),
});
const {IAnyFunc: checkerAnyFunc} = tic.createCheckers({IAnyFunc});
const checkerAnyResult = checkerAnyFunc.methodResult("invoke");

const anyChecker: tic.Checker = checkerAnyResult;

/**
 * A little helper that processes message queues when starting an rpc instance.
 */
function processQueue(queue: IMessage[], processFunc: (msg: IMessage) => void) {
  let i = 0;
  try {
    while (i < queue.length) {
      // i gets read and then incremented before the call, so that if processFunc throws, the
      // message still gets removed from the queue (to avoid processing it twice).
      processFunc(queue[i++]);
    }
  } finally {
    queue.splice(0, i);
  }
}

type MaybePromise = Promise<void> | void;

/**
 * Calls callback(), handling the exception both synchronously and not. If callback and handler
 * both return or throw synchronously, then so does this method.
 */
function catchMaybePromise(callback: () => MaybePromise, handler: (err: Error) => MaybePromise): MaybePromise {
  try {
    const p = callback();
    if (p) {
      return p.catch(handler);
    }
  } catch (err) {
    return handler(err);
  }
}
