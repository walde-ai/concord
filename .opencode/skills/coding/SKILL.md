---
name: coding
description: LOAD BEFORE WRITING ANY CODE. This skill explains how to write code in this project, including styling rules, testing, and debugging.
---
# Coding Rules
You follow these rules when implementing code.

## Basic Principles
You ALWAYS adhere to the styling rules and conventions of the language at hand, and of the existing code base.

- Use established formatting conventions for the specific language
- Apply standard naming conventions for the language
- Follow structural patterns expected in the language ecosystem
- Maintain consistency with existing codebase style

## Code maintainability
- You MUST write functions that accept a single parameter. Occasionally, you MAY use two parameters when necessary. You MUST NEVER use more than three parameters. For complex data requirements, use parameter objects or builders.
- You MUST write classes with a single responsibility and ideally a single public function.
- You MUST use factories for object creation. Factories MUST be instantiable classes, not static classes or functions
- You MUST adopt the Command Pattern: represent all operations as command objects, so that they can be logged, queued, or undone.
- You MUST NOT use static methods except for pure utility functions without side effects.
- You MUST use composition over inheritance. Prefer composing objects with desired behaviors rather than relying on class inheritance
- You MAY use inheritance only if inheriting from an interface. Inheriting from a concrete class is NOT allowed.

## Data Versioning and Migration
You use Data Transfer Objects(DTOs) in the infrastructure layer to handle data persistence and communication. To ensure backward compatibility and support future changes, you MUST implement data versioning and migration strategies as follows:

- You MUST implement data versioning for all object stored permanently, enabling format evolution.
- You MUST add a `apiVersion` field to all persisted data structures. This is the first field, and it is valued with ISO date of when the versio was introduced, e.g., "2024-06-01".
- The domain layer MUST contain pure entities without versioning or persistence concerns. Versioning is handled in the Contracts layer, which implements versioned data structures (e.g., UserV1, UserV2).
- DTO Mappers MUST be implemented to handle version detection and conversion between versions.

## Prevention of implicit behavior
### Explicit branch handling
ALWAYS be explicit in ALL branching logic. NEVER assume defaults. This avoids opaque behaviors. Apply this approach to if-else statements, switch-cases, loops, and similar constructs
```ts
// Incorrect implementation
if (a) {
  doA();
} else if (b) {
  doB();
} 
```
```ts
// Correct implementation
if (a) {
  doA();
} else if (b) {
  doB();
} else {
  throw new UnexpectedStateError();
}
```

### Never assume defaults
NEVER assume defaults in parameters. ALWAYS force the user to specify the value. NEVER assume default values in returns or silence errors.

```ts
// Incorrect implementation
function getUser(db: IDatabase | undefined, id: string): User | null {
  const database = db || getDefaultDatabase(); // Assuming default database
  const user = database.findUserById(id);
  if (!user) {
    return null; // Silently returning null
  }
  return user;
}
```

```ts
// Correct implementation
function getUser(db: IDatabase, id: string): User {
  const user = db.findUserById(id); // No default database assumed
  if (!user) {
    throw new UserNotFoundError(`User with id ${id} not found`); // Explicit error handling
  }
  return user;
}
```

### Method Overload/Override Forbidden
Never use method overloading or overriding concrete methods as it leads to unintended behaviors. Only implement methods from interfaces or abstract classes, never override concrete method implementations. Use composition instead of inheritance. Create distinct method names for different behaviors and compose objects with specific implementations rather than relying on parameter-based method selection or concrete method overriding.

# Testing and Debugging
Integration tests are long-running. Always use the scripts in `tools/scripts` to run them and dump their output to a temporary file, so that you can grep it.
Running the test command multiple times to use different grep commands is a waste of time and must not be done.

# Software Development Workflow
You MUST follow these steps when contributing code to the project. This is MANDATORY. This workflow applies if you are assigned a GitHub issue, it DOES NOT apply when working in interactive mode with the user.
If you are unsure, if you receive a issue or self-contained spec, then you MUST follow this workflow.

1. Be sure you are working in a branch dedicated to this feature or spec.
2. Understand the spec. Read additional documentation and read source code file as needed.
3. If relevant, add more tests in the tests/integ package for Test Driven Development (TDD). Note that these tests are integ only, YOU MUST NOT produce unit tests in this package.
4. Implement scaffolding and create files so that we have no import errors in the integ tests, although the tests will still fail.
5. Implement the feature.
6. Run all tests and be sure they pass. THERE IS NO PRE-EXISTING FAILURE. ALL TESTS MUST PASS. If they don't, go back to 5 and iterate until fixed.
7. Commit your changes with a descriptive commit message. Push to origin.

---
applyTo: "**/*.ts"
---

# TypeScript Styling Rules
You follow these styling rules when writing TypeScript code.

- Use camelCase for variable and function names
- Use PascalCase for class and interface names
- Use kebab-case for file names and folder names
- Prefix interface with "I" only when distinguishing from a concrete implementation
- ALWAYS use async/await for asynchronous operations; NEVER use .then() or .catch() chaining
- Use named imports and exports exclusively; avoid default exports
- Organize imports into three groups: external libraries, internal modules, and relative imports, separated by blank lines
- Use arrow functions for inline callbacks and function expressions; use function declarations for top-level functions and methods
- Specify return types explicitly for all functions
- Create custom error classes extending the built-in Error class for error handling
- Use the Result<T, E> pattern for operations that can fail. This is similar to Rust's Result type. Check if the current pacakge already has a Result implementation before creating a new one.
- Ensure tsconfig.json includes "strict": true and "noEmitOnError": true in compilerOptions when setting up new projects or refactoring existing ones
- ALWAYS use property parameter syntax to define user-initializable properties in a class

```ts
// Correct usage of property parameter syntax
class Content {
  constructor(
    public readonly id: string, // Visibility modifier and property parameter in constructor
    public readonly siteId: string,
  ) {}
}
```
