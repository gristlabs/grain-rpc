import {assert} from "chai";
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
  public async getGreeting(name: string): Promise<string> { return `Hello, ${name}!`; }
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

  it("should support rpc channeling ", async () => {
    const [abRpc, bRpc] = createRpcPair();
    const [acRpc, cRpc] = createRpcPair();
    abRpc.pipe("b2c", acRpc);
    const b2cRpc = cRpc.pipe("b2c");
    const c2bRpc = bRpc.pipe("b2c");
    await assertHelloWorld(abRpc, bRpc);
    await assertHelloWorld(acRpc, cRpc);
    await assertHelloWorld(b2cRpc, c2bRpc);
  });

});

async function assertHelloWorld(aRpc: Rpc, bRpc: Rpc) {
  aRpc.registerImpl("my-greeting", new MyGreeting());
  const stub = bRpc.getStub<IGreet>("my-greeting");
  assert.equal(await stub.getGreeting("World"), "Hello, World!");
}

function createRpcPair(): [Rpc, Rpc] {
  const aRpc = new Rpc();
  const bRpc = new Rpc();
  aRpc.start((msg) => bRpc.receiveMessage(msg));
  bRpc.start((msg) => aRpc.receiveMessage(msg));
  return [aRpc, bRpc];
}
