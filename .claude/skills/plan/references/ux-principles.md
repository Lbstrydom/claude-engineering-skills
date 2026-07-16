---
summary: 26 UX + design principles — Gestalt, interaction, cognitive load, accessibility, state/resilience.
---

# UX + Design Principles — Full Tables

Reference for Phase 2 (Apply UX & Design Principles) in `/plan`
(frontend/full-stack scope). Cite principle numbers in the plan's "UX Design Decisions" section when
justifying each choice.

## Gestalt Principles

| # | Principle | Design Question |
|---|---|---|
| 1 | **Proximity** | Are related items grouped together? Is whitespace creating clear clusters? |
| 2 | **Similarity** | Do elements that function alike look alike? (Same colour, size, shape) |
| 3 | **Continuity** | Does the eye follow a natural path through the layout? Are alignments clean? |
| 4 | **Closure** | Can the user brain complete implied shapes/groups? Are containers clear? |
| 5 | **Figure-Ground** | Is the focal content clearly distinguishable from the background? |
| 6 | **Common Region** | Are grouped items enclosed in a shared visual boundary? |
| 7 | **Common Fate** | Do elements that change together move/animate together? |

## Interaction & Usability

| # | Principle | Design Question |
|---|---|---|
| 8 | **Clear Affordances** | Does each interactive element look clickable/draggable/editable? Can the user tell what to do without instructions? |
| 9 | **User Logic & Flow** | Does the sequence of steps match how the user thinks about the task, not how the code is structured? |
| 10 | **Consistency** | Do similar actions behave the same way everywhere? Same terms, same patterns, same positions? |
| 11 | **Feedback & System Status** | Does the user always know what is happening? Loading indicators, success confirmations, error messages? |
| 12 | **Error Prevention & Recovery** | Can users undo mistakes? Are destructive actions confirmed? Is inline validation present? |
| 13 | **Progressive Disclosure** | Is complexity hidden until needed? Does the UI start simple and reveal depth on demand? |
| 14 | **Recognition Over Recall** | Can users see their options rather than having to remember them? Are hints and labels visible? |

## Cognitive Load & Decision Science

| # | Principle | Design Question |
|---|---|---|
| 15 | **Hick's Law** | Are choices kept minimal? Can options be chunked or categorised to reduce overwhelm? |
| 16 | **Fitts's Law** | Are primary actions large and easy to reach? Are destructive actions small and distant from primary paths? |
| 17 | **Visual Hierarchy** | Does typography scale, colour weight, and spacing guide the eye to what matters most first? |
| 18 | **Whitespace & Breathing Room** | Does the layout feel spacious or cramped? Is there enough negative space to reduce cognitive load? |

## Accessibility & Inclusion

| # | Principle | Design Question |
|---|---|---|
| 19 | **Keyboard Navigation** | Can every interactive element be reached and operated via keyboard alone? |
| 20 | **Screen Reader Support** | Are ARIA labels, roles, and live regions properly set? Do dynamic updates announce themselves? |
| 21 | **Colour Contrast** | Does text meet WCAG AA contrast ratios (4.5:1 body, 3:1 large)? Is colour never the only indicator? |
| 22 | **Focus Management** | When modals open, does focus move in? When they close, does focus return? Are focus traps correct? |

## State & Resilience

| # | Principle | Design Question |
|---|---|---|
| 23 | **State Coverage** | Does every component handle: empty, loading, error, success, and partial states? |
| 24 | **Performance Perception** | Are skeleton screens, optimistic updates, or transitions used to make waits feel shorter? |
| 25 | **Responsive Design** | Does the layout adapt gracefully from mobile to desktop? Are touch targets 44px minimum? |
| 26 | **Dark Pattern Avoidance** | Is the UI honest? No tricks, hidden costs, forced actions, or misleading defaults? |

## Nielsen's 10 Heuristics (cross-check pass)

Run these as a final validation over the design. If any fails, revisit:

1. Visibility of system status
2. Match between system and real world
3. User control and freedom
4. Consistency and standards
5. Error prevention
6. Recognition rather than recall
7. Flexibility and efficiency of use
8. Aesthetic and minimalist design
9. Help users recognise, diagnose, and recover from errors
10. Help and documentation
