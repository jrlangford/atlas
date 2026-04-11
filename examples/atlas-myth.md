# Atlas — The Titan Who Held the Sky

> *"Atlas was forced to hold up the celestial heavens for eternity as punishment from Zeus."*

In Greek mythology, **Atlas** was a Titan — son of Iapetus and the Oceanid Asia — condemned by Zeus after the Titanomachy to bear the weight of the heavens on his shoulders. His brothers fared similarly: **Prometheus** was chained to a rock, **Epimetheus** loosed evils upon mankind, and **Menoetius** was struck down with a thunderbolt.

## Lineage

```mermaid
graph TD
    Uranus((Uranus)) --> Iapetus
    Gaia((Gaia)) --> Iapetus
    Oceanus((Oceanus)) --> Asia
    Tethys((Tethys)) --> Asia
    Iapetus --> Atlas
    Iapetus --> Prometheus
    Iapetus --> Epimetheus
    Iapetus --> Menoetius
    Asia --> Atlas
    Asia --> Prometheus
    Asia --> Epimetheus
    Asia --> Menoetius

    style Atlas fill:#2da44e,stroke:#2c974b,color:#fff
    style Prometheus fill:#d29922,stroke:#bf8700,color:#fff
    style Epimetheus fill:#d29922,stroke:#bf8700,color:#fff
    style Menoetius fill:#d29922,stroke:#bf8700,color:#fff
```

## The Trick of Heracles

As one of his twelve labours, Heracles sought the golden apples of the Hesperides — Atlas's own daughters. Rather than fetch them himself, he struck a bargain with the Titan:

```mermaid
sequenceDiagram
    participant H as Heracles
    participant A as Atlas
    participant Hes as Hesperides

    H->>A: I'll hold the sky while you fetch the apples
    A->>A: (stretches, cracks back)
    A->>Hes: Hand them over, daughters
    Hes-->>A: Three golden apples
    A-->>H: Here you go — I'll just carry them to Eurystheus myself
    H->>A: Of course — just take the sky back for a moment<br/>while I pad my shoulders
    A->>A: (resumes the burden)
    H->>H: *walks off with the apples*
    Note over A: Tricked once again.
```

---

*This document is a test fixture for Atlas, the markdown viewer. It exercises headings, blockquotes, mermaid diagrams, and emphasis.*
