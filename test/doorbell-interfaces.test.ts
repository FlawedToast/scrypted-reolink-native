import { describe, expect, it } from "vitest";
import { ScryptedDeviceType, ScryptedInterface } from "@scrypted/sdk";
import { getDeviceInterfaces } from "../src/utils";

/**
 * Issue #25 — a Reolink Video Doorbell PoE paired into HomeKit as a plain
 * camera: no doorbell chime on HomePods, no automations, and forcing the type
 * by hand broke pairing (a Doorbell without BinarySensor is not a valid HAP
 * accessory).
 *
 * The root cause was upstream — nodelink-js answered isDoorbell=false because
 * this firmware exposes no `doorbellVersion` and the standalone capability
 * path never passed the model name (fixed in nodelink-js 0.7.1). This test
 * pins the plugin half of the contract: given isDoorbell, the device MUST come
 * out as a Doorbell *and* carry BinarySensor. Those two must never drift
 * apart, whichever way the capability is decided.
 */

const logger = console;

function caps(over: Partial<Record<string, unknown>> = {}): any {
  return {
    channel: 0,
    ptzMode: "none",
    hasPan: false,
    hasTilt: false,
    hasZoom: false,
    hasPresets: false,
    hasPtz: false,
    hasBattery: false,
    hasIntercom: true,
    hasSiren: true,
    hasFloodlight: true,
    hasPir: false,
    hasAutotracking: false,
    isDoorbell: false,
    hasWirelessChime: false,
    hasPowerSourceSwitch: false,
    ...over,
  };
}

describe("doorbell interfaces (issue #25)", () => {
  it("a doorbell is typed Doorbell and carries BinarySensor", () => {
    const { interfaces, type } = getDeviceInterfaces({
      capabilities: caps({ isDoorbell: true }),
      logger,
    });
    expect(type).toBe(ScryptedDeviceType.Doorbell);
    expect(interfaces).toContain(ScryptedInterface.BinarySensor);
  });

  it("the type and the BinarySensor interface never disagree", () => {
    // HomeKit rejects the pairing if one is present without the other; that is
    // exactly what the reporter hit when they set the type by hand.
    for (const isDoorbell of [true, false]) {
      const { interfaces, type } = getDeviceInterfaces({
        capabilities: caps({ isDoorbell }),
        logger,
      });
      expect(interfaces.includes(ScryptedInterface.BinarySensor)).toBe(
        type === ScryptedDeviceType.Doorbell,
      );
    }
  });

  it("a non-doorbell stays a Camera with no BinarySensor", () => {
    const { interfaces, type } = getDeviceInterfaces({
      capabilities: caps(),
      logger,
    });
    expect(type).toBe(ScryptedDeviceType.Camera);
    expect(interfaces).not.toContain(ScryptedInterface.BinarySensor);
  });

  it("the PoE doorbell keeps siren/floodlight children and its overlays", () => {
    const { interfaces } = getDeviceInterfaces({
      capabilities: caps({ isDoorbell: true }),
      logger,
    });
    expect(interfaces).toContain(ScryptedInterface.DeviceProvider);
    expect(interfaces).toContain(ScryptedInterface.VideoTextOverlays);
  });
});
