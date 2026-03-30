---
layout: single
title: "Field-Level Inference"
description: "Extracting maximum cosmological information by analyzing the full matter field"
header:
  teaser: /assets/img/illustris.jpg
importance: 3
excerpt: ""
---

Traditional cosmological analyses rely on compressing observational data into summary statistics --- most commonly the two-point correlation function or power spectrum. While this approach is optimal for Gaussian random fields, the nonlinear gravitational evolution of cosmic structure introduces significant non-Gaussianity on small scales. This means that summary statistics inevitably discard cosmological information, particularly about parameters like the neutrino mass and the equation of state of dark energy that leave their strongest signatures in the nonlinear regime.

Field-level inference is a fundamentally different approach: instead of compressing the data, we perform inference directly on the full three-dimensional matter field. By forward-modeling the evolution of the Universe from initial conditions to the observed field and comparing the result to data, we can in principle extract all of the available cosmological information --- not just the fraction captured by summary statistics.

### Simulation-Based Inference

A key challenge in field-level inference is that the likelihood of the full field is intractable --- we cannot write down an analytic expression for the probability of observing a given configuration of galaxies. Simulation-based inference (SBI) circumvents this by using simulations as an implicit likelihood. Rather than evaluating the likelihood directly, SBI methods learn the mapping from simulated data to posterior distributions over cosmological parameters using neural networks. I have contributed to developing SBI benchmarks for upcoming surveys like LSST, establishing the accuracy and reliability of these methods for real-world cosmological analysis.

### Microcanonical Langevin Monte Carlo

Sampling the posterior distribution over initial conditions of the Universe is an extraordinarily high-dimensional problem --- the number of parameters equals the number of voxels in the volume being analyzed, often in the millions. I have worked on applying Microcanonical Langevin Monte Carlo (MCLMC) to this problem. MCLMC is a gradient-based sampling algorithm that is particularly well-suited to high-dimensional spaces, enabling efficient exploration of the posterior over initial conditions and, in turn, tight constraints on cosmological parameters from the full field.

Field-level inference represents the frontier of cosmological data analysis, and its development is critical for fully exploiting the enormous datasets that will be delivered by the next generation of cosmological surveys.
