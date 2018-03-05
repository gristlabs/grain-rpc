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
 * Pipes
 * -----
 * Pipes allow to create rpc channels over several others rpc channels. In a common usage example,
 * an endpoint (A) has two rpc channels connected to two endpoint (B) and (C), Rpc pipes make it
 * possible to create an rpc between (B) and (C) with all messages going through (A).
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

export type SendMessageCB = (msg: IMessage) => PromiseLike<void> | void;

export class Rpc extends EventEmitter {

  /**
   * Forward all messages piped under `name` from on rpc to the other one and vise versa.
   */
  public static pipe(name: string, aRpc: Rpc, bRpc: Rpc) {
    aRpc.pipeToFunction(name, (msg: IMessage) => bRpc.sendMessage(msg));
    bRpc.pipeToFunction(name, (msg: IMessage) => aRpc.sendMessage(msg));
  }

  /**
   * Creates an Rpc instance which will pipe all its messages under `name` over the same channel as
   * the provided `rpc` without interferring. On the other side of the channel, to forward the piped
   * messages from the rpc which is received the messages to another rpc for send over another
   * channel, use `Rpc.pipe` with the same name and both rpcs. Or, to have an rpc instance to handle
   * the messages call `Rpc.pipeEndpoint` instead with the same name and the rpc receiving messages.
   *
   * note: start() has already been called on the returned instance.
   */
  public static pipeEndpoint(name: string, rpc: Rpc): Rpc {
    const endpoint = new Rpc();
    endpoint.start((msg) => {
      if (!msg.mpipes) {
        msg.mpipes = [];
      }
      msg.mpipes.push(name);
      rpc.sendMessage(msg);
    });
    // register pipes to route its messages on reception
    rpc.pipeToFunction(name, (msg: IMessage) => {
      if (!msg.mpipes) {
        throw new Error("rpc: msg.mpipes should not be undefined!");
      }
      msg.mpipes.pop();
      endpoint.receiveMessage(msg);
    });
    return endpoint;
  }

  public sendMessage: SendMessageCB;

  private _inactiveQueue: IMessage[] | null;
  private _logger: IRpcLogger;
  private _implMap: {[name: string]: Implementation} = {};
  private _pendingCalls: Map<number, ICallObj> = new Map();
  private _nextRequestId = 1;
  private _pipes: {[name: string]: SendMessageCB} = {};

  /**
   * To use Rpc, you must call start() with a function that sends a message to the other side. If
   * you pass in such a function to the constructor, it's the same as calling start() right away.
   * You must also call receiveMessage() for every message received from the other side.
   */
  constructor(options: {logger?: IRpcLogger, sendMessage?: SendMessageCB} = {}) {
    super();
    const {logger = console, sendMessage = inactiveSend} = options;
    this._logger = logger;
    this.sendMessage = sendMessage;
    this._inactiveQueue = (this.sendMessage === inactiveSend) ? [] : null;
  }

  /**
   * To use Rpc, call this for every message received from the other side of the channel.
   */
  public receiveMessage(msg: any): void {
    if (this._inactiveQueue) {
      this._inactiveQueue.push(msg);
    } else {
      this._dispatch(msg);
    }
  }

  /**
   * Until start() is called, received messages are queued. This gives you an opportunity to
   * register implementations and add "message" listeners without the risk of missing messages,
   * even if receiveMessage() has already started being called.
   */
  public start(sendMessage: SendMessageCB) {
    this.sendMessage = sendMessage;
    if (this._inactiveQueue) {
      for (const msg of this._inactiveQueue) {
        this._dispatch(msg);    // We need to be careful not to throw from here.
      }
      this._inactiveQueue = null;
    }
  }

  /**
   * Messaging interface: send data to the other side, to be emitted there as a "message" event.
   */
  public async postMessage(data: any): Promise<void> {
    const msg: IMsgCustom = {mtype: MsgType.Custom, data};
    await this.sendMessage(msg);
  }

  /**
   * Registers a new implementation under the given name. It is an error if this name is already
   * in use. To skip all validation, use `registerImpl<any>(...)` and omit the last argument.
   * TODO Check that registerImpl without a type param requires a checker.
   */
  public registerImpl<Iface extends any>(name: string, impl: any): void;
  public registerImpl<Iface>(name: string, impl: Iface, checker: tic.Checker): void;
  public registerImpl(name: string, impl: any, checker?: tic.Checker): void {
    if (this._implMap.hasOwnProperty(name)) {
      throw new Error(`Rpc.registerImpl has already been called for ${name}`);
    }
    if (!checker) {
      this._implMap[name] = {name, impl, argsCheckers: null};
    } else {
      const ttype = getType(checker);
      if (!(ttype instanceof tic.TIface)) {
        throw new Error("Rpc.registerImpl requires a Checker for an interface");
      }
      const argsCheckers: {[name: string]: tic.Checker} = {};
      for (const prop of ttype.props) {
        if (prop.ttype instanceof tic.TFunc) {
          argsCheckers[prop.name] = checker.methodArgs(prop.name);
        }
      }
      this._implMap[name] = {name, impl, argsCheckers};
    }
  }

  /**
   * Unregister an implementation, if one was registered with this name.
   */
  public unregisterImpl(name: string): void {
    delete this._implMap[name];
  }

  /**
   * Creates a local stub for the given remote interface. The stub implements Iface, forwarding
   * calls to the remote implementation, each one returning a Promise for the received result.
   * To skip all validation, use `any` for the type and omit the last argument.
   */
  public getStub<Iface extends any>(name: string): any;
  public getStub<Iface>(name: string, checker: tic.Checker): Iface;
  public getStub(name: string, checker?: tic.Checker): any {
    if (!checker) {
      // TODO Test, then explain how this works.
      return new Proxy({}, {
        get: (target, property: string, receiver) => {
          return (...args: any[]) => this._makeCall(name, property, args, anyChecker);
        },
      });
    } else {
      const ttype = getType(checker);
      if (!(ttype instanceof tic.TIface)) {
        throw new Error("Rpc.getStub requires a Checker for an interface");
      }
      const api: any = {};
      for (const prop of ttype.props) {
        if (prop.ttype instanceof tic.TFunc) {
          const resultChecker = checker.methodResult(prop.name);
          api[prop.name] = (...args: any[]) => this._makeCall(name, prop.name, args, resultChecker);
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
   * Unregister a afunction, if one was registered with this name.
   */
  public unregisterFunc(name: string): void {
    return this.unregisterImpl(name);
  }

  /**
   * Call a remote function registered with registerFunc. Does no type checking.
   */
  public callRemoteFunc(name: string, ...args: any[]): Promise<any> {
    return this._makeCall(name, "invoke", args, anyChecker);
  }

  /**
   * Redirect all the in-coming message sent from a pipe endpoint with the same name to the
   * callback. Most of the time you will not use `pipeToFunction` directly but `Rpc.pipe` or
   * `Rpc.pipeEndpoint` instead.
   */
  public pipeToFunction(name: string, cb: (msg: IMessage) => void) {
    if (this._pipes.hasOwnProperty(name)) {
      throw new Error(`pipe ${name} already set`);
    } else {
      this._pipes[name] = cb;
    }
  }

  private _makeCall(iface: string, meth: string, args: any[], resultChecker: tic.Checker): Promise<any> {
    return new Promise((resolve, reject) => {
      const reqId = this._nextRequestId++;
      const callObj: ICallObj = {reqId, iface, meth, resolve, reject, resultChecker};
      this._pendingCalls.set(reqId, callObj);

      // Send the Call message. If the sending fails, reject the _makeCall promise. If it
      // succeeds, we save {resolve,reject} to resolve _makeCall when we get back a response.
      this._info(callObj, "RPC_CALLING");
      const msg: IMsgRpcCall = {mtype: MsgType.RpcCall, reqId, iface, meth, args};
      Promise.resolve().then(() => this.sendMessage(msg)).catch((err) => {
        this._pendingCalls.delete(reqId);
        reject(err);
      });
    });
  }

  private _dispatch(msg: IMessage): void {

    if (msg.mpipes && msg.mpipes.length) {
      const pipe = msg.mpipes[msg.mpipes.length - 1];
      if (this._pipes.hasOwnProperty(pipe)) {
        this._pipes[pipe](msg);
        return;
      }
      msg.mpipes.pop();
    }

    switch (msg.mtype) {
      case MsgType.RpcCall: { this._onMessageCall(msg); return; }
      case MsgType.RpcRespData:
      case MsgType.RpcRespErr: { this._onMessageResp(msg); return; }
      case MsgType.Custom: { this.emit("message", msg.data); return; }
    }
  }

  private async _onMessageCall(call: IMsgRpcCall): Promise<void> {
    if (!this._implMap.hasOwnProperty(call.iface)) {
      return this._failCall(call, "RPC_UNKNOWN_INTERFACE", "Unknown interface");
    }

    const impl: Implementation = this._implMap[call.iface];
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
      result = await impl.impl[call.meth](...call.args);
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
      await this.sendMessage(msg);
    }
  }

  private async _sendResponse(reqId: number, data: any): Promise<void> {
    const msg: IMsgRpcRespData = {mtype: MsgType.RpcRespData, reqId, data};
    await this.sendMessage(msg);
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
}

// Helper to fail if we try to call a method or post a message before start() has been called.
function inactiveSend(msg: IMessage): void {
  throw new Error("Rpc cannot be used before start() has been called");
}

interface Implementation {
  name: string;
  impl: any;    // The actual object implementing the interface described by desc.
  argsCheckers: null | {
    [name: string]: tic.Checker;
  };
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

// TODO Hack: expose this in ts-interface-checker
function getType(checker: tic.Checker): tic.TType {
  return (checker as any).ttype;
}
