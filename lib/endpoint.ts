/**
 *
 * Implement basic routing of messages across a network of links.
 * Endpoints have names that are unique across the network.
 * The network is composed of nodes, with links between the nodes.
 * Each node keeps track of which endpoints are reachable via
 * which link, so that it can incrementally move messages along
 * to their named destination.  Messages have an envelope that
 * declares the endpoint they should be delivered to, and the
 * endpoint to which any reply should be delivered back to.
 *
 * To use:
 *  - Instantiate a Node object in each distinct computational element.
 *  - Call node.addOutput to tell the node how to send data to neigboring
 *    nodes.
 *  - Call node.listen(target) to get an rpc element reachable from the 
 *    network with a given name, `target`.
 *  - Anywhere else in the network, call node.connect(target) to get an
 *    rpc to talk to the endpoint called `target` as if they were on other
 *    ends of a simple channel.
 *
 * Limitations:
 * The current routing "algorithm" is just a sketch.  Each connected node ends
 * up with an entry for each endpoint on the network, which is inefficient.
 * There is no provision for endpoints leaving the network.  Undeliverable
 * messages will just stall in a queue waiting for an endpoint to show up.
 *
 */

import {IMessage, MsgType} from "./message";
import {Rpc, SendMessageCB} from "./rpc";

/**
 * Routing information for messages in transit - where they are going to, and where they
 * came from.
 *
 */
export interface IEnvelope {
  destEndpoint: string;
  srcEndpoint: string;
}

/**
 * All the links one node has that lead to neighboring nodes.
 */
export class Link {
  /** Endpoints reachable through this link, and their cost */
  public distances = new Map<string, number>();

  public constructor(public name: string,  // link name should be unique within node
                     public sendMessage: SendMessageCB,  // callback for sending data
                     public cost: number,  // cost of transmission across this link
                     public node: Node) {  // node that owns this link
  }

  /** Receive a message from this link */
  public receiveMessage(msg: any): void {
    this.node.receiveInput(name, msg);
  }
}

/**
 * End consumers/generators of messages that are attached to a specific node.
 */
export class Endpoint {
  public constructor(public name: string,  // endpoint name, unique across network
                     public dest: Rpc,     // rpc object used for communication
                     public node: Node,    // node to which endpoint is attached
                     public target?: string) {  // name of endpoint we communicate with,
                                           // if we initiate communcation.
  }

  public async recv(msg: any): Promise<void> {
    if (!this.target) {
      throw new Error("nowhere to send message");
    }
    return this.node.deliver(msg, {
      destEndpoint: this.target,
      srcEndpoint: name,
    });
  }
}

/**
 * A routing element that communicates with its peers in order to deliver messages
 * and replies to and from named endpoints.
 */
export class Node {
  private _links = new Map<string, Link>();  // connections to peers, by link name
  private _steps = new Map<string, Link>();  // connections to peers, by endpoint
  private _mine = new Map<string, Endpoint>(); // endpoints attached to this node
  private _queue = new Array<any>(); // queue of messages not yet deliverable
  private _connectedRpcs = new Map<string, Rpc>(); // rpcs that are connected to a specific target
  private _listeningRpcs = new Map<string, Rpc>(); // rpcs that are listening with a given name

  public constructor(public nodeName: string) {  // nodename should be unique across network
  }

  /**
   * Add an output from this node to a neigboring node.
   */
  public addOutput(linkName: string, sendMessage: SendMessageCB, cost: number): Link {
    const link = new Link(linkName, sendMessage, cost, this);
    this._links.set(linkName, link);
    for (const listener of this._mine.values()) {
      link.sendMessage({
        mtype: MsgType.Custom,
        data: null,
        name: listener.name,
        cost: 0.0,
      } as IMessage);
    }
    for (const [name, step] of this._steps.entries()) {
      link.sendMessage({
        mtype: MsgType.Custom,
        data: null,
        name,
        cost: step.distances.get(name),
      } as IMessage);
    }
    this._update();
    return link;
  }

  /**
   * Receive input from a neighboring node.
   */
  public receiveInput(linkName: string, data: any): void {
    const link = this._links.get(linkName);
    if (!link) {
      throw new Error(`unknown link ${linkName} for node ${this.nodeName}`);
    }
    if (data.msgEnvelope) {
      this.deliver(data, data.msgEnvelope);
      return;
    }
    if (data.name) {
      if (this._mine.get(data.name)) {
        // this post does not interest us.
        return;
      }
      const cost = data.cost + link.cost;
      const prevLink = this._steps.get(data.name);
      if (prevLink) {
        const prevCost = prevLink.distances.get(data.name);
        if (prevCost! < cost) {
          // this post does not interest us.
          return;
        }
      }
      link.distances.set(data.name, cost);
      this._steps.set(data.name, link);

      for (const altLink of this._links.values()) {
        if (altLink.name !== linkName) {
          altLink.sendMessage({
            mtype: MsgType.Custom,
            data: null,
            name: data.name,
            cost,
          } as IMessage);
        }
      }
      this._update();
    }
  }

  /** return an Rpc for communicating with a given endpointName. */
  public connect(endpointName: string, replyName?: string): Rpc {
    let rpc = this._connectedRpcs.get(endpointName);
    if (!rpc) {
      const returnName = replyName || `${this.nodeName}#${endpointName}`;
      rpc = new Rpc();
      this.addEndpoint(rpc, returnName, endpointName);
      this._connectedRpcs.set(endpointName, rpc);
    }
    return rpc;
  }

  public getStub<Iface>(endpointName: string, interfaceName: string): Iface {
    return this.connect(endpointName).getStub<Iface>(interfaceName);
  }

  public listen(endpointName: string): Rpc {
    let rpc = this._listeningRpcs.get(endpointName);
    if (!rpc) {
      rpc = new Rpc();
      this.addEndpoint(rpc, endpointName);
      this._listeningRpcs.set(endpointName, rpc);
    }
    return rpc;
  }

  public registerImpl<Iface>(endpointName: string, interfaceName: string, impl: Iface): void {
    return this.listen(endpointName).registerImpl<Iface>(interfaceName, impl);
  }


  /**
   * Give an rpc endpoint a routable name on the network.
   * Optionally, declare a target endpoint to which any traffic it
   * initiates should be routed to.
   */
  public addEndpoint(rpc: Rpc, name: string, target?: string): void {
    const listener = new Endpoint(name, rpc, this, target);
    this._mine.set(name, listener);
    for (const link of this._links.values()) {
      // tell neigbors about this endpoint
      link.sendMessage({
        mtype: MsgType.Custom,
        data: null,
        name,
        cost: 0.0,
      } as IMessage);
    }
    rpc.start((msg: any) => {
      if (!target) {
        throw new Error("Cannot ship data without a target");
      }
      this.deliver(msg, {
        destEndpoint: target,
        srcEndpoint: name,
      });
    });
    this._update();
  }

  /**
   * deliver a message to its target, or move it one step along, or enqueue it for
   * when a route becomes available
   */
  public async deliver(msg: any, env: IEnvelope): Promise<void> {
    msg.msgEnvelope = env;
    const me = this._mine.get(env.destEndpoint);
    if (me) {
      const altEnv: IEnvelope = {
        destEndpoint: env.srcEndpoint,
        srcEndpoint: env.destEndpoint,
      };
      return me.dest.receiveMessage(msg, (reply: any) => this.deliver(reply, altEnv));
    }
    const step = this._steps.get(env.destEndpoint);
    if (step) {
      step.sendMessage(msg);
    } else {
      this._queue.push(msg);
    }
  }

  /** routing has changed, see if we can pass along any messages */
  private _update() {
    const pending: any[] = this._queue.splice(0);
    for (const msg of pending) {
      this.deliver(msg, msg.msgEnvelope);
    }
  }
}
