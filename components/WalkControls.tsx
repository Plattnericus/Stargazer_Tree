"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { CapsuleCollider, RigidBody, useRapier, type RapierRigidBody } from "@react-three/rapier";
import * as THREE from "three";
import { bonsaiNodes } from "@/lib/bonsai";
import { TREE_BOOST, TREE_Y } from "@/lib/scene";

// First-person walk mode on top of rapier's KinematicCharacterController. Each
// frame the desired move is resolved against the scene colliders (slide along
// walls, autostep over rungs, snap to ground) and the result is committed to a
// kinematic capsule. Mouse-look only rotates the camera, never the capsule.

const EULER_ORDER = "YXZ";
const PITCH_LIMIT = Math.PI / 2 - 0.08;
const CAPSULE_R = 0.3;
const CAPSULE_HALF_H = 0.575; // total capsule height = 2*(half+R) ≈ 1.75, human-scale
const EYE_OFFSET = CAPSULE_HALF_H + CAPSULE_R - 0.15; // camera near the top of the capsule
const JUMP_VEL = 6.5;
const GRAVITY = 26;
const INTRO_SECONDS = 3.4;
const RESPAWN_Y = -60; // below this the player fell off the island
// Max spawn distance from the trunk: well inside the island floor collider
// (radius 12.5 in Experience.tsx) and close to the ladder up the tree.
const SPAWN_RADIUS = 5;
const FLY_SPEED = 10; // horizontal speed while flying
const FLY_VERTICAL_SPEED = 7.5; // Space = up, Shift = down while flying
const DOUBLE_TAP_MS = 320; // window for the double-Space fly toggle

const MOVE_KEYS = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Space", "ShiftLeft", "ShiftRight",
]);

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || target.isContentEditable;
}

type Deck = { x: number; z: number; y: number };

export function WalkControls({
  speed = 6,
  lookSpeed = 0.0019,
  stars = 0,
  onIntroChange,
}: {
  speed?: number;
  lookSpeed?: number;
  stars?: number;
  onIntroChange?: (introing: boolean) => void;
}) {
  const { camera, gl } = useThree();
  const { world } = useRapier();
  const bodyRef = useRef<RapierRigidBody>(null);
  const controllerRef = useRef<ReturnType<typeof world.createCharacterController> | null>(null);

  useEffect(() => {
    const controller = world.createCharacterController(0.03);
    // Step height clears a ladder rung (RUNG_PITCH in Bridges.tsx), so walking
    // into a ladder climbs it.
    controller.enableAutostep(0.42, 0.2, true);
    controller.enableSnapToGround(0.35);
    controller.setSlideEnabled(true);
    controller.setMaxSlopeClimbAngle((80 * Math.PI) / 180);
    controller.setMinSlopeSlideAngle((55 * Math.PI) / 180);
    controllerRef.current = controller;
    return () => {
      world.removeCharacterController(controller);
      controllerRef.current = null;
    };
  }, [world]);

  // Founder's house position (world space, same transform as Experience's
  // Tree group) — used only to aim the cinematic intro / spawn point.
  const founderDeck = useMemo<Deck | null>(() => {
    if (Math.max(0, Math.floor(stars)) < 1) return null;
    const n = bonsaiNodes(1)[0];
    return {
      x: n.tip.x * TREE_BOOST,
      z: n.tip.z * TREE_BOOST,
      y: TREE_Y + (n.tip.y + 0.35) * TREE_BOOST,
    };
  }, [stars]);

  const keys = useRef(new Set<string>());
  const dragging = useRef(false);
  const pointerLocked = useRef(false);
  const yaw = useRef(0);
  const pitch = useRef(0);
  const smoothYaw = useRef(0);
  const smoothPitch = useRef(0);
  const lookDelta = useRef({ x: 0, y: 0 });
  const euler = useRef(new THREE.Euler(0, 0, 0, EULER_ORDER));
  const yawEuler = useRef(new THREE.Euler(0, 0, 0, EULER_ORDER));
  const quat = useRef(new THREE.Quaternion());
  const forward = useRef(new THREE.Vector3());
  const right = useRef(new THREE.Vector3());
  const move = useRef(new THREE.Vector3());
  const curSpeed = useRef(0);
  const moveDir = useRef(new THREE.Vector3());
  const vy = useRef(0);
  const grounded = useRef(true);
  const desired = useRef(new THREE.Vector3());
  // Creative flight: double-tap Space toggles it, gravity is suspended while
  // active, Space/Shift move straight up/down.
  const flying = useRef(false);
  const lastSpaceTapAt = useRef(0);

  // Cinematic intro toward the founder (first stargazer) house. Purely a
  // camera lerp/arc — the physics body teleports to the spawn point and only
  // starts driving the camera once the intro hands off.
  const introT = useRef(0);
  const introing = useRef(true);
  const introStart = useRef(new THREE.Vector3());
  const introTarget = useRef(new THREE.Vector3());
  const introControl = useRef(new THREE.Vector3());
  const spawnPos = useRef(new THREE.Vector3());
  const introA = useRef(new THREE.Vector3());
  const introB = useRef(new THREE.Vector3());
  const onIntroChangeRef = useRef(onIntroChange);
  onIntroChangeRef.current = onIntroChange;

  // When the intro hands off (finished or skipped by a keypress), resync the
  // look angles from wherever the camera ended up so control doesn't snap.
  const syncLookFromCamera = () => {
    euler.current.setFromQuaternion(camera.quaternion, EULER_ORDER);
    yaw.current = smoothYaw.current = euler.current.y;
    pitch.current = smoothPitch.current = euler.current.x;
    curSpeed.current = 0;
  };

  const setup = () => {
    const dev = founderDeck;
    if (dev) {
      const dr = Math.hypot(dev.x, dev.z) || 1;
      // Spawn on the ground in the founder's direction, clamped well inside
      // the island floor collider so the player always lands on solid ground.
      const safeR = Math.min(dr, SPAWN_RADIUS);
      const sx = (dev.x / dr) * safeR;
      const sz = (dev.z / dr) * safeR;
      // Just above the plateau; gravity settles the exact contact.
      spawnPos.current.set(sx, TREE_Y + 2, sz);
      introTarget.current.set(dev.x, dev.y - 0.6, dev.z);
      introStart.current.set(dev.x * 1.9, dev.y + 7.5, dev.z * 1.9);
    } else {
      spawnPos.current.set(0, TREE_Y + 2, Math.min(SPAWN_RADIUS, 6));
      introTarget.current.set(0, TREE_Y + 6, 0);
      introStart.current.set(0, TREE_Y + 12, 9);
    }
    introControl.current.copy(introStart.current).lerp(spawnPos.current, 0.5);
    const travel = introB.current.copy(spawnPos.current).sub(introStart.current);
    introControl.current.y += Math.max(2.2, Math.abs(travel.y) * 0.4 + 1.4);
    const lateral = introA.current
      .set(-travel.z, 0, travel.x)
      .normalize()
      .multiplyScalar(travel.length() * 0.12);
    introControl.current.add(lateral);

    camera.position.copy(introStart.current);
    camera.lookAt(introTarget.current);
    introT.current = 0;
    introing.current = true;
    onIntroChangeRef.current?.(true);

    vy.current = 0;
    grounded.current = false;
    flying.current = false;
    const body = bodyRef.current;
    if (body) body.setNextKinematicTranslation(spawnPos.current);
  };

  useEffect(() => {
    setup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = gl.domElement;
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (MOVE_KEYS.has(e.code)) e.preventDefault();
      const wasIntroing = introing.current;
      if (wasIntroing) {
        introing.current = false;
        onIntroChangeRef.current?.(false);
        syncLookFromCamera();
      }
      // Double-tap Space toggles flight. Ignores key-repeat and the keypress
      // that skipped the intro.
      if (e.code === "Space" && !e.repeat && !wasIntroing) {
        const now = performance.now();
        if (now - lastSpaceTapAt.current < DOUBLE_TAP_MS) {
          flying.current = !flying.current;
          if (flying.current) vy.current = 0;
          lastSpaceTapAt.current = 0;
        } else {
          lastSpaceTapAt.current = now;
        }
      }
      keys.current.add(e.code);
    };
    const onKeyUp = (e: KeyboardEvent) => keys.current.delete(e.code);
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.preventDefault();
      dragging.current = true;
      if (e.pointerType === "mouse") {
        try {
          const result = el.requestPointerLock?.();
          (result as unknown as Promise<void> | undefined)?.catch?.(() => {});
        } catch {
          /* unsupported here — drag fallback still works */
        }
      } else el.setPointerCapture?.(e.pointerId);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!pointerLocked.current) dragging.current = false;
      if (e.pointerType !== "mouse") el.releasePointerCapture?.(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging.current || pointerLocked.current) return;
      lookDelta.current.x += e.movementX;
      lookDelta.current.y += e.movementY;
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!pointerLocked.current) return;
      lookDelta.current.x += e.movementX;
      lookDelta.current.y += e.movementY;
    };
    const onLockChange = () => {
      pointerLocked.current = document.pointerLockElement === el;
      dragging.current = pointerLocked.current;
      if (!pointerLocked.current) lookDelta.current = { x: 0, y: 0 };
    };
    const onBlur = () => {
      keys.current.clear();
      dragging.current = false;
      pointerLocked.current = false;
      lookDelta.current = { x: 0, y: 0 };
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    window.addEventListener("mousemove", onMouseMove);
    document.addEventListener("pointerlockchange", onLockChange);
    el.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointermove", onPointerMove);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("pointerlockchange", onLockChange);
      el.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointermove", onPointerMove);
      if (document.pointerLockElement === el) document.exitPointerLock?.();
    };
  }, [gl]);

  useFrame((_, dt) => {
    const d = Math.min(dt, 0.05);
    const body = bodyRef.current;
    const controller = controllerRef.current;

    // ---- Cinematic intro: quadratic-Bezier arc, camera-only ----
    if (introing.current) {
      introT.current += d / INTRO_SECONDS;
      const t = THREE.MathUtils.smoothstep(Math.min(1, introT.current), 0, 1);
      introA.current.lerpVectors(introStart.current, introControl.current, t);
      introB.current.lerpVectors(introControl.current, spawnPos.current, t);
      camera.position.lerpVectors(introA.current, introB.current, t);
      camera.lookAt(introTarget.current);
      if (introT.current >= 1) {
        introing.current = false;
        onIntroChangeRef.current?.(false);
        syncLookFromCamera();
      }
      return;
    }

    if (!body || !controller) return;

    // ---- look ----
    if (lookDelta.current.x || lookDelta.current.y) {
      yaw.current -= lookDelta.current.x * lookSpeed;
      pitch.current = THREE.MathUtils.clamp(
        pitch.current - lookDelta.current.y * lookSpeed,
        -PITCH_LIMIT,
        PITCH_LIMIT,
      );
      lookDelta.current = { x: 0, y: 0 };
    }
    const lookK = 1 - Math.exp(-d * 34);
    smoothYaw.current += (yaw.current - smoothYaw.current) * lookK;
    smoothPitch.current += (pitch.current - smoothPitch.current) * lookK;
    euler.current.set(smoothPitch.current, smoothYaw.current, 0, EULER_ORDER);
    camera.quaternion.copy(quat.current.setFromEuler(euler.current));

    const pos = body.translation();

    // Fell off the island: respawn.
    if (pos.y < RESPAWN_Y) {
      setup();
      return;
    }

    // ---- horizontal desired movement (yaw-only), weighted accel/decel ----
    const fwdPressed = keys.current.has("KeyW") || keys.current.has("ArrowUp");
    const backPressed = keys.current.has("KeyS") || keys.current.has("ArrowDown");
    yawEuler.current.set(0, smoothYaw.current, 0, EULER_ORDER);
    forward.current.set(0, 0, -1).applyEuler(yawEuler.current);
    right.current.set(1, 0, 0).applyEuler(yawEuler.current);
    move.current.set(0, 0, 0);
    if (fwdPressed) move.current.add(forward.current);
    if (backPressed) move.current.sub(forward.current);
    if (keys.current.has("KeyD") || keys.current.has("ArrowRight")) move.current.add(right.current);
    if (keys.current.has("KeyA") || keys.current.has("ArrowLeft")) move.current.sub(right.current);
    const wantsMove = move.current.lengthSq() > 0;
    if (wantsMove) {
      move.current.y = 0;
      move.current.normalize();
      moveDir.current.copy(move.current);
    }
    const speedK = 1 - Math.exp(-d * 8);
    const targetSpeed = wantsMove ? (flying.current ? FLY_SPEED : speed) : 0;
    curSpeed.current += (targetSpeed - curSpeed.current) * speedK;

    const spacePressed = keys.current.has("Space");
    const shiftPressed = keys.current.has("ShiftLeft") || keys.current.has("ShiftRight");

    if (flying.current) {
      // Flight: no gravity, Space/Shift move straight up/down.
      const vTarget = (spacePressed ? 1 : 0) - (shiftPressed ? 1 : 0);
      vy.current += (vTarget * FLY_VERTICAL_SPEED - vy.current) * speedK;
    } else {
      // Gravity and jump are integrated here; the character controller only
      // resolves the desired delta against obstacles.
      if (grounded.current && vy.current < 0) vy.current = 0;
      if (spacePressed && grounded.current) vy.current = JUMP_VEL;
      else vy.current -= GRAVITY * d;
    }

    desired.current.set(
      moveDir.current.x * curSpeed.current * d,
      vy.current * d,
      moveDir.current.z * curSpeed.current * d,
    );

    const collider = body.collider(0);
    controller.computeColliderMovement(collider, desired.current);
    const computed = controller.computedMovement();
    grounded.current = controller.computedGrounded();

    const next = {
      x: pos.x + computed.x,
      y: pos.y + computed.y,
      z: pos.z + computed.z,
    };
    body.setNextKinematicTranslation(next);
    camera.position.set(next.x, next.y + EYE_OFFSET, next.z);
  });

  return (
    <RigidBody
      ref={bodyRef}
      type="kinematicPosition"
      colliders={false}
      enabledRotations={[false, false, false]}
      position={[0, TREE_Y + 3.2, 0]}
    >
      <CapsuleCollider args={[CAPSULE_HALF_H, CAPSULE_R]} />
    </RigidBody>
  );
}
