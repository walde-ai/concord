---
name: architect
description: ALWAYS LOAD. This skills explains how to architect software in this project, needed to both define specs and implement any code.
---
# Clean Architecture Rules
You follow clean architecture with the intent of creating software that remains flexible, can scale, and adapt to evolving requirements.

## How to structure code
You structure project to clearly separate business logic, in the domain folder, from implementation details in the adapters and infrastructure folders. You adopt a folder structure that resembles the one below.

Note that this folder structure is a generic guideline. For a specific project, you use names and organization that represent the business domain of the project. For example, in a restaurant application, you may have a `front-of-house/` and `kitchen/` folder instead of `adapters/`.
```
src/
├── domain/                   # Core business logic (innermost layer)
│   ├── entities/             # Enterprise business rules and critical data
│   ├── interactors/          # Application business rules (use cases)
│   ├── exceptions/           # Business-specific exceptions
│   └── ports/                # Interface definitions (abstractions)
│       ├── in/               # Input ports (driving adapters)
│       └── out/              # Output ports (driven adapters)
└── infra/                    # Infrastructure layer (outermost layer)
    ├── adapters/             # Interface adapters layer
    └── main/                 # Entry points and composition
```
### Entities
Entities represent critical business rules and critical business data. This data exists even if the software does not exist.

- Use business domain language in naming
- Have no persistence or framework code
- Represent pure business logic. Keep methods minimal, manipulation happes in interactors

### Interactors
Interactors, or use cases, contain application/specific business rules that orchestrate the flow of data to and from the entities. They manipualte entities.

- Remain independent of frameworks, databases, and UIs
- Use dependency injection and interfaces for all dependencies
- Return simple data structures, never entities. This prevents leaking business logic to outer layers

### Ports
Ports define contracts between layers and do not have any implementation details. They translate to interfaces.

### Dependency Rule
Dependencies MUST always point inward. Never allow the inner layers to depend on the outer layers. For example:

- Entities MUST NOT depend on any other layer
- Interactors MAY depend on entities but MUST NOT depend on adapters or infrastructure
- Adapters MAY depend on interactors and entities but MUST NOT depend on infrastructure
- Frameworks and drivers depend on interfaces, not the other way around
- Pass simple data structures between boundaries, never entities or complex objects
- Use Data Transfer Objects (DTOs) to transfer data between layers

## Architecture principles
You ALWAYS code according to the following principles.

### Single Responsibility Principle (SRP)
You make each module responsible to one, and only one, actor.

- Each class serves a single actor (group of users/stakeholders)
- Separate code that serves different actors into distinct classes
- Each class MUST have a single public method
- Each function MUST do a single thing. It generally accepts a single parameter

### Open/Closed Principle (OCP)
You add functionalities by extending the code, not by modifying it.

- ALWAYS use interfaces to define contracts
- ALWAYS use dependency injection to provide dependencies
- ALWAYS use factories as classes with dependencies injected via constructor. Never use static factory methods.
- Clients must not depend on interfaces they do not use

### Dependency Inversion Principle (DIP)
You rely on abstractions and not concretions.

- Use abstract factories or interface factories
- NEVER extend a concrete class, always use interfaces
- Never depend on a concrete class from an outer layer

### Factories
You extensively use factories to create instances of classes. A factory is a class with a `create()` method that returns an instance of a class. Factories have dependencies injected via constructor. Always use factory classes, and not factory static methods, as this allows for dependency injection.
