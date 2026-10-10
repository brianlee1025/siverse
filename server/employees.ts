import fs from "node:fs";
import type { Department, Employee } from "../shared/types";
import { MAX_HEADCOUNT } from "../shared/types";
import { employeeMemoryDir } from "./config";
import { pickWorkerName } from "./names";
import { OfficeError, schedule } from "./office";
import { changed, newId, state } from "./store";

// Permanent employees: hired into a department, they keep one desk and focus on their own area of
// the department's work. Tasks and schedules can be given to them by name, and they keep their own
// notes (employeeMemoryDir) next to the department's shared ones, so they get better at their area
// over time. A department's other desks are for temps, who come in for a single task.

const MAX_NAME = 30;
const MAX_FOCUS = 400;

export function departmentStaff(departmentId: string): Employee[] {
  return state.employees.filter((e) => e.departmentId === departmentId);
}

function nameTaken(name: string, except?: Employee) {
  return state.employees.some((e) => e !== except && e.name.toLowerCase() === name.toLowerCase());
}

function cleanName(name: string, except?: Employee): string {
  const clean = name.trim().replace(/\s+/g, " ").slice(0, MAX_NAME);
  if (!clean) throw new OfficeError("An employee needs a name.");
  // Names are how the boss and the manager address employees, so they must be unique.
  if (nameTaken(clean, except)) throw new OfficeError(`There is already an employee called ${clean}. Pick another name.`);
  return clean;
}

function cleanFocus(focus: string): string {
  const clean = focus.trim().slice(0, MAX_FOCUS);
  if (!clean) throw new OfficeError("Give them an area to focus on, e.g. \"competitor pricing\".");
  return clean;
}

function randomName(): string {
  const inUse = new Set([
    ...state.employees.map((e) => e.name),
    ...state.tasks.filter((t) => t.status === "working").map((t) => t.workerName ?? ""),
  ]);
  const base = pickWorkerName(inUse);
  let name = base;
  for (let i = 2; nameTaken(name); i++) name = `${base} ${i}`;
  return name;
}

/** Hires someone onto the department's first desk without a permanent owner, adding a desk if needed. */
export function hireEmployee(department: Department, input: { name?: string; focus: string }): Employee {
  const focus = cleanFocus(input.focus);
  const name = input.name?.trim() ? cleanName(input.name) : randomName();
  const owned = new Set(departmentStaff(department.id).map((e) => e.deskIndex));
  let deskIndex = 0;
  while (owned.has(deskIndex)) deskIndex++;
  if (deskIndex >= MAX_HEADCOUNT) {
    throw new OfficeError(`${department.name} is full: all ${MAX_HEADCOUNT} desks have a permanent employee.`);
  }
  if (deskIndex >= department.headcount) department.headcount = deskIndex + 1;

  const employee: Employee = { id: newId("emp"), departmentId: department.id, name, focus, deskIndex, hiredAt: Date.now() };
  fs.mkdirSync(employeeMemoryDir(employee.id), { recursive: true });
  state.employees.push(employee);
  changed();
  schedule();
  return employee;
}

export function updateEmployee(employee: Employee, patch: { name?: string; focus?: string }) {
  if (patch.name !== undefined) employee.name = cleanName(patch.name, employee);
  if (patch.focus !== undefined) employee.focus = cleanFocus(patch.focus);
  changed();
}

/**
 * Lets an employee go. Their desk stays, for temps. Tasks and schedules waiting for them go to
 * whoever is free. Their notes are kept unless `deleteNotes` is set.
 */
export function fireEmployee(employee: Employee, { deleteNotes = false } = {}) {
  const current = state.tasks.find((t) => t.employeeId === employee.id && t.status === "working");
  if (current) {
    throw new OfficeError(`${employee.name} is working on "${current.title}". Wait for it, or send them home first.`);
  }
  for (const task of state.tasks) if (task.employeeId === employee.id && task.status === "queued") delete task.employeeId;
  for (const s of state.schedules) if (s.employeeId === employee.id) delete s.employeeId;
  state.employees = state.employees.filter((e) => e !== employee);
  if (deleteNotes) fs.rmSync(employeeMemoryDir(employee.id), { recursive: true, force: true });
  changed();
  schedule();
}

/** When a department closes, its staff leave with it. Their notes stay on disk. */
export function removeDepartmentStaff(departmentId: string) {
  state.employees = state.employees.filter((e) => e.departmentId !== departmentId);
}

/** Checks a new desk count against the staff, and moves anyone whose desk is going to a free one. */
export function fitStaffToDesks(department: Department, headcount: number) {
  const staff = departmentStaff(department.id);
  if (headcount < staff.length) {
    throw new OfficeError(
      `${department.name} has ${staff.length} permanent employee(s), so it needs at least ${staff.length} desk(s). Fire someone first.`,
    );
  }
  const owned = new Set(staff.filter((e) => e.deskIndex < headcount).map((e) => e.deskIndex));
  for (const employee of staff) {
    if (employee.deskIndex < headcount) continue;
    let desk = 0;
    while (owned.has(desk)) desk++;
    employee.deskIndex = desk;
    owned.add(desk);
  }
}

/** Who a permanent employee is, for the top of their prompt. */
export function employeeIntro(employee: Employee, department: Department): string {
  return `You are ${employee.name}, a permanent member of the ${department.name} team.
Your own area: ${employee.focus}
Most of your work is in this area and you get better at it over time, so keep your own notes up to date. If a task falls outside your area, do it well anyway.`;
}

/** One line per employee, for the manager's view of the office. */
export function describeStaff(departmentId: string): string[] {
  return departmentStaff(departmentId).map((e) => {
    const task = state.tasks.find((t) => t.employeeId === e.id && t.status === "working");
    const queued = state.tasks.filter((t) => t.employeeId === e.id && t.status === "queued").length;
    const doing = task ? `working on "${task.title}"` : "free";
    return `  - ${e.name} [id: ${e.id}], focus: ${e.focus}. ${doing}${queued ? `, ${queued} waiting for them` : ""}.`;
  });
}
