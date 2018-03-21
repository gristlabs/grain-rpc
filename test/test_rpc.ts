import {assert} from "chai";
import {EventEmitter} from "events";
import {Rpc} from "../lib/rpc";

interface ICalc {
  add(x: number, y: number): number;
}

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

function waitForEvent(emitter: EventEmitter, eventName: string): Promise<any> {
  return new Promise((resolve) => emitter.once(eventName, resolve));
}

describe("ts-rpc", () => {
  it("should be able to make unchecked stubs and call methods", async () => {
    const rpc = new Rpc();
    rpc.start((msg) => rpc.receiveMessage(msg));
    rpc.registerImpl<ICalc>("calc", new Calc());
    const stub = rpc.getStub<ICalc>("calc");
    assert(stub);
    assert.equal(await stub.add(4, 5), 9);
  });

  it("should support hello world without a checker", async () => {
    const aRpc = new Rpc();
    const bRpc = new Rpc();
    aRpc.start((msg) => bRpc.receiveMessage(msg));
    bRpc.start((msg) => aRpc.receiveMessage(msg));
    aRpc.registerImpl("my-greeting", new MyGreeting());
    const stub = bRpc.getStub<IGreet>("my-greeting");
    assert.equal(await stub.getGreeting("World"), "Hello, World!");
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
    BtoD.registerForwarder("bar", BtoA);
    AtoB.registerForwarder("bar", AtoC);

    BtoA.registerImpl("my-greeting", new MyGreeting(" [from B]"));
    BtoA.registerFunc("func", async (name: string) => `Yo ${name} [from B]`);

    CtoA.registerImpl("my-greeting", new MyGreeting(" [from C]"));
    CtoA.registerFunc("func", async (name: string) => `Yo ${name} [from C]`);

    assert.equal(await AtoB.getStub<IGreet>("my-greeting").getGreeting("World"),
      "Hello, World! [from B]");
    assert.equal(await CtoA.getStub<IGreet>("foo.my-greeting").getGreeting("World"),
      "Hello, World! [from B]");
    assert.equal(await AtoB.callRemoteFunc("func", "Santa"), "Yo Santa [from B]");
    assert.equal(await CtoA.callRemoteFunc("foo.func", "Santa"), "Yo Santa [from B]");

    assert.equal(await AtoC.getStub<IGreet>("my-greeting").getGreeting("World"),
      "Hello, World! [from C]");
    assert.equal(await DtoB.getStub<IGreet>("bar.my-greeting").getGreeting("World"),
      "Hello, World! [from C]");
    assert.equal(await AtoC.callRemoteFunc("func", "Santa"), "Yo Santa [from C]");
    assert.equal(await DtoB.callRemoteFunc("bar.func", "Santa"), "Yo Santa [from C]");

    // Test forwarding of custom messages.
    let p: Promise<any>;
    p = waitForEvent(AtoC, "message");
    await CtoA.postMessage({hello: 1});
    assert.deepEqual(await p, {hello: 1});

    p = waitForEvent(BtoA, "message");
    await CtoA.postMessage("foo", {hello: 2});
    assert.deepEqual(await p, {hello: 2});

    p = waitForEvent(BtoD, "message");
    await DtoB.postMessage({world: 3});
    assert.deepEqual(await p, {world: 3});

    p = waitForEvent(CtoA, "message");
    await DtoB.postMessage("bar", {world: 4});
    assert.deepEqual(await p, {world: 4});
  });
});

function createRpcPair(): [Rpc, Rpc] {
  const aRpc: Rpc = new Rpc({sendMessage: (msg) => bRpc.receiveMessage(msg)});
  const bRpc: Rpc = new Rpc({sendMessage: (msg) => aRpc.receiveMessage(msg)});
  return [aRpc, bRpc];
}
