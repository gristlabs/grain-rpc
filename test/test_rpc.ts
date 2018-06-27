import {assert, use} from "chai";
import * as chaiAsPromised from "chai-as-promised";
import {EventEmitter} from "events";
import * as sinon from "sinon";
import {createCheckers} from "ts-interface-checker";
import {Rpc} from "../lib/rpc";
import {ICalc} from "./ICalc";
import ICalcTI from "./ICalc-ti";

use(chaiAsPromised);

const checkersForICalc = createCheckers(ICalcTI).ICalc;

class Calc implements ICalc {
  public add(x: number, y: number): number {
    return x + y;
  }
}

interface IGreet {
  getGreeting(name: string): Promise<string>;
}

class MyGreeting implements IGreet {
  constructor(private suffix: string = "") {}
  public async getGreeting(name: string): Promise<string> { return `Hello, ${name}!${this.suffix}`; }
}

const defaults = { logger: {} };

function waitForEvent(emitter: EventEmitter, eventName: string): Promise<any> {
  return new Promise((resolve) => emitter.once(eventName, resolve));
}

describe("Rpc", () => {

  describe("basics", () => {

    it("should be able to make unchecked stubs and call methods", async () => {
      const rpc = new Rpc(defaults);
      rpc.start((msg) => rpc.receiveMessage(msg));
      rpc.registerImpl<ICalc>("calc", new Calc());
      const stub = rpc.getStub<ICalc>("calc");
      assert(stub);
      assert.equal(await stub.add(4, 5), 9);
    });

    it("should support hello world without a checker", async () => {
      const aRpc = new Rpc(defaults);
      const bRpc = new Rpc(defaults);
      aRpc.start((msg) => bRpc.receiveMessage(msg));
      bRpc.start((msg) => aRpc.receiveMessage(msg));
      aRpc.registerImpl("my-greeting", new MyGreeting());
      const stub = bRpc.getStub<IGreet>("my-greeting");
      assert.equal(await stub.getGreeting("World"), "Hello, World!");
    });

  });

  describe("getStub", () => {

    it("should be able to return safely from async methods", async () => {
      const rpc = new Rpc(defaults);
      rpc.start((msg) => rpc.receiveMessage(msg));
      rpc.registerImpl<ICalc>("calc", new Calc());
      // Unchecked stubs will not return well from async methods if they look thenable
      // and javascript code results in a Promise.resolve.
      async function getCalc() {
        return rpc.getStub<ICalc>("calc");
      }
      const stub = await getCalc();
      assert(stub);
      assert.equal(await stub.add(4, 5), 9);
    });

    it("should be able to pass through Promise.resolve", async () => {
      const rpc = new Rpc(defaults);
      rpc.start((msg) => rpc.receiveMessage(msg));
      rpc.registerImpl<ICalc>("calc", new Calc());
      const stub = Promise.resolve(rpc.getStub<ICalc>("calc"));
      assert.equal(await stub.then((calc) => calc.add(4, 5)), 9);
    });

  });

  describe("checker", () => {

    it("should allow calling methods that exist", async () => {
      const rpc = new Rpc(defaults);
      rpc.start((msg) => rpc.receiveMessage(msg));
      rpc.registerImpl<ICalc>("calc", new Calc(), checkersForICalc);
      const stub = rpc.getStub<ICalc>("calc", checkersForICalc);
      assert.equal(await stub.add(4, 5), 9);
    });

    it("should catch missing methods at typed stub", async () => {
      const rpc = new Rpc(defaults);
      const stub = rpc.getStub<ICalc>("calc", checkersForICalc);
      // "any" cast needed to avoid typescript catching the error
      assert.throws(() => (stub as any).additionify(4, 5), /is not a function/);
    });

    it("should catch missing methods at implementation for untyped stub", async () => {
      const rpc = new Rpc(defaults);
      rpc.start((msg) => rpc.receiveMessage(msg));
      rpc.registerImpl<ICalc>("calc", new Calc(), checkersForICalc);
      const stub = rpc.getStub<ICalc>("calc");
      await assert.isRejected((stub as any).additionify(4, 5), /Unknown method/);
    });

    it("should catch bad + missing arguments at implementation", async () => {
      const rpc = new Rpc(defaults);
      rpc.start((msg) => rpc.receiveMessage(msg));
      rpc.registerImpl<ICalc>("calc", new Calc(), checkersForICalc);
      const stub = rpc.getStub<ICalc>("calc") as any;
      await assert.isRejected(stub.add("hello", 5), /not a number/);
      await assert.isRejected(stub.add(), /value.x is missing/);
      await assert.isRejected(stub.add(1), /value.y is missing/);
      await assert.equal(await stub.add(10, 9, 8), 19);  // by default, extra args are allowed
    });
  });

  it("should support forwarding calls", async () => {
    const [AtoB, BtoA] = createRpcPair();
    const [AtoC, CtoA] = createRpcPair();
    const [DtoB, BtoD] = createRpcPair();

    // In the naming of the Rpc objects, think the first letter as the entity that maintains this
    // Rpc object, and the second letter as Rpc's other endpoint. Then we have this topology:
    //             |BtoA| <--> |AtoB|
    //             |    |      |AtoC| <--> |CtoA|
    // |DtoB| <--> |BtoD|

    // Allow C to call to B by calling A with "foo" forwarder.
    AtoC.registerForwarder("foo", AtoB);

    // Allow D to call to C via B and A with "bar" forwarder.
    BtoD.registerForwarder("bar", BtoA, "bar");
    AtoB.registerForwarder("bar", AtoC);

    BtoA.registerImpl("my-greeting", new MyGreeting(" [from B]"));
    BtoA.registerFunc("func", async (name: string) => `Yo ${name} [from B]`);

    CtoA.registerImpl("my-greeting", new MyGreeting(" [from C]"));
    CtoA.registerFunc("func", async (name: string) => `Yo ${name} [from C]`);

    assert.equal(await AtoB.getStub<IGreet>("my-greeting").getGreeting("World"),
      "Hello, World! [from B]");
    assert.equal(await CtoA.getStubForward<IGreet>("foo", "my-greeting").getGreeting("World"),
      "Hello, World! [from B]");
    assert.equal(await AtoB.callRemoteFunc("func", "Santa"), "Yo Santa [from B]");
    assert.equal(await CtoA.callRemoteFuncForward("foo", "func", "Santa"), "Yo Santa [from B]");

    assert.equal(await AtoC.getStub<IGreet>("my-greeting").getGreeting("World"),
      "Hello, World! [from C]");
    assert.equal(await DtoB.getStubForward<IGreet>("bar", "my-greeting").getGreeting("World"),
      "Hello, World! [from C]");
    assert.equal(await AtoC.callRemoteFunc("func", "Santa"), "Yo Santa [from C]");
    assert.equal(await DtoB.callRemoteFuncForward("bar", "func", "Santa"), "Yo Santa [from C]");

    // Test forwarding of custom messages.
    let p: Promise<any>;
    p = waitForEvent(AtoC, "message");
    await CtoA.postMessage({hello: 1});
    assert.deepEqual(await p, {hello: 1});

    p = waitForEvent(BtoA, "message");
    await CtoA.postMessageForward("foo", {hello: 2});
    assert.deepEqual(await p, {hello: 2});

    p = waitForEvent(BtoD, "message");
    await DtoB.postMessage({world: 3});
    assert.deepEqual(await p, {world: 3});

    p = waitForEvent(CtoA, "message");
    await DtoB.postMessageForward("bar", {world: 4});
    assert.deepEqual(await p, {world: 4});
  });

  it("should support @ syntax", async () => {
    const [AtoB, BtoA] = createRpcPair();
    const [AtoC, CtoA] = createRpcPair();
    AtoC.registerForwarder("foo", AtoB);

    BtoA.registerImpl("my-greeting", new MyGreeting(" [from B]"));
    BtoA.registerFunc("func", async (name: string) => `Yo ${name} [from B]`);

    CtoA.registerImpl("my-greeting", new MyGreeting(" [from C]"));
    CtoA.registerFunc("func", async (name: string) => `Yo ${name} [from C]`);

    assert.equal(await CtoA.getStub<IGreet>("my-greeting@foo").getGreeting("World"),
      "Hello, World! [from B]");
    assert.equal(await CtoA.callRemoteFunc("func@foo", "Santa"), "Yo Santa [from B]");

    assert.isRejected(CtoA.callRemoteFunc("func@food", "Santa"),
                      /Unknown forward/);
    assert.isRejected(CtoA.callRemoteFunc("@foo", "Santa"),
                      /Unknown interface/);
    assert.isRejected(CtoA.callRemoteFunc("func@funkytown@foo", "Santa"),
                      /Unknown interface/);
  });

  it("should support forwarding to *", async () => {

   // |BtoA| <--> |AtoB|
   // |    |
   // |BtoC| <--> |CtoB|
   // |    |
   // |Bto*| <--> |DtoB|
   //             |DtoE| <--> |EtoD|
   //             |    |
   //             |DtoF| <--> |FtoD|
   const [BtoA   , AtoB] = createRpcPair();
   const [BtoC   , CtoB] = createRpcPair();
   const [BtoAll , DtoB] = createRpcPair();
   const [DtoE   , EtoD] = createRpcPair();
   const [DtoF   , FtoD] = createRpcPair();

   BtoA.registerForwarder("my_c", BtoC);
   BtoA.registerForwarder("*", BtoAll);
   DtoB.registerForwarder("my_e", DtoE);
   DtoB.registerForwarder("my_f", DtoF);

   CtoB.registerImpl("my-greeting", new MyGreeting(" [From C]"));
   AtoB.registerImpl("my-greeting", new MyGreeting(" [From A]"));
   EtoD.registerImpl("my-greeting", new MyGreeting(" [From E]"));
   FtoD.registerImpl("my-greeting", new MyGreeting(" [From F]"));

   assert.equal(await AtoB.getStub<IGreet>("my-greeting@my_c").getGreeting("World"), "Hello, World! [From C]");
   assert.equal(await AtoB.getStub<IGreet>("my-greeting@my_e").getGreeting("World"), "Hello, World! [From E]");
   assert.equal(await AtoB.getStub<IGreet>("my-greeting@my_f").getGreeting("World"), "Hello, World! [From F]");

  });

  it("should support wrapping calls", async () => {
    const before = sinon.spy();
    const after = sinon.spy();
    const rpc = new Rpc({...defaults, callWrapper: async (makeCall: () => Promise<any>) => {
      before();
      try {
        return await makeCall();
      } finally {
        after();
      }
    }});
    rpc.start(rpc.receiveMessage.bind(rpc));
    rpc.registerImpl<ICalc>("calc", new Calc());
    const stub = rpc.getStub<ICalc>("calc");
    assert(stub);
    await stub.add(4, 5);
    assert.equal(before.callCount, 1);
    assert.equal(after.callCount, 1);
  });

  it("should support queueing messages when rpc is inactive", async () => {
    const aRpc = new Rpc(defaults);
    const bRpc = new Rpc(defaults);
    bRpc.start((msg) => aRpc.receiveMessage(msg));

    aRpc.registerImpl<IGreet>("greet", new MyGreeting(" from a"));
    bRpc.registerImpl<IGreet>("greet", new MyGreeting(" from b"));

    const bStub = bRpc.getStub<IGreet>("greet");
    const aStub = aRpc.getStub<IGreet>("greet");

    assert(bStub);
    assert(aStub);
    let noneResolved = true;
    let bGreeting = bStub.getGreeting("Santa").then((res) => (noneResolved = false, res));
    let aGreeting = aStub.getGreeting("Santa").then((res) => (noneResolved = false, res));

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(noneResolved, true);
    aRpc.start((msg) => bRpc.receiveMessage(msg));
    assert.equal(await bGreeting, "Hello, Santa! from a");
    assert.equal(await aGreeting, "Hello, Santa! from b");

    aRpc.stop();
    noneResolved = true;
    bGreeting = bStub.getGreeting("Bob").then((res) => (noneResolved = false, res));
    aGreeting = aStub.getGreeting("Bob").then((res) => (noneResolved = false, res));

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(noneResolved, true);
    aRpc.start((msg) => bRpc.receiveMessage(msg));
    assert.equal(await bGreeting, "Hello, Bob! from a");
    assert.equal(await aGreeting, "Hello, Bob! from b");

  });

});

function createRpcPair(): [Rpc, Rpc] {
  const aRpc: Rpc = new Rpc({logger: {}, sendMessage: (msg) => bRpc.receiveMessage(msg)});
  const bRpc: Rpc = new Rpc({logger: {}, sendMessage: (msg) => aRpc.receiveMessage(msg)});
  return [aRpc, bRpc];
}
