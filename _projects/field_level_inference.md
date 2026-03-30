---
layout: single
title: "Beyond Summary Statistics"
description: "Using field-level inference, simulation-based inference, and machine learning to maximally extract cosmological information"
header:
  teaser: /assets/img/cosmic_web.jpg
importance: 3
excerpt: ""
---

Traditional cosmological analyses rely on compressing observational data into summary statistics --- most commonly the two-point correlation function or power spectrum. While this approach is optimal for Gaussian random fields, the nonlinear gravitational evolution of cosmic structure introduces significant non-Gaussianity on small scales. This means that summary statistics inevitably discard cosmological information, particularly about parameters like the neutrino mass and the equation of state of dark energy that leave their strongest signatures in the nonlinear regime. My work develops methods that go beyond these limitations to extract the maximum possible information from cosmological data.

### Field-Level Inference

Instead of compressing the data, field-level inference performs inference directly on the full three-dimensional matter field. By forward-modeling the evolution of the Universe from initial conditions to the observed field and comparing the result to data, we can in principle extract all of the available cosmological information --- not just the fraction captured by summary statistics.

Sampling the posterior distribution over initial conditions of the Universe is an extraordinarily high-dimensional problem --- the number of parameters equals the number of voxels in the volume being analyzed, often in the millions. I have worked on applying Microcanonical Langevin Monte Carlo (MCLMC) to this problem. MCLMC is a gradient-based sampling algorithm that is particularly well-suited to high-dimensional spaces, enabling efficient exploration of the posterior over initial conditions and, in turn, tight constraints on cosmological parameters from the full field.

### Simulation-Based Inference

A key challenge is that the likelihood of the full field is intractable --- we cannot write down an analytic expression for the probability of observing a given configuration of galaxies. Simulation-based inference (SBI) circumvents this by using simulations as an implicit likelihood. Rather than evaluating the likelihood directly, SBI methods learn the mapping from simulated data to posterior distributions over cosmological parameters using neural networks. I have contributed to developing <a href="https://doi.org/10.48550/arXiv.2402.05137">SBI benchmarks</a> for upcoming surveys like LSST, establishing the accuracy and reliability of these methods for real-world cosmological analysis.

### Neural Networks for Neutrino Mass

Standard analyses compress the rich information in weak lensing maps into the power spectrum. However, in the nonlinear regime, significant information is encoded in the higher-order structure of the fields. I have developed <a href="https://doi.org/10.48550/arXiv.2406.03076">convolutional neural network (CNN) architectures</a> that operate directly on weak lensing convergence maps to constrain the neutrino mass. By learning to extract non-Gaussian features that are invisible to two-point statistics, these networks can substantially tighten neutrino mass constraints beyond what is achievable with traditional methods.

### Velocity Reconstruction

Galaxy peculiar velocities contain a wealth of cosmological information that is complementary to galaxy positions alone. I have developed methods for <a href="https://doi.org/10.48550/arXiv.2210.15657">joint velocity and density reconstruction</a>, combining galaxy clustering and peculiar velocity data to tighten constraints on cosmological parameters. Peculiar velocities are particularly powerful for breaking degeneracies between parameters like the growth rate of structure and the amplitude of matter fluctuations.

These methods --- field-level inference, simulation-based inference, machine learning, and multi-probe reconstruction --- represent the frontier of cosmological data analysis and are critical for fully exploiting the enormous datasets arriving from the next generation of surveys.
