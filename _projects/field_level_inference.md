---
layout: single
title: "Optimal and Robust Cosmology"
description: "Using field-level inference, simulation-based inference, and machine learning to optimally and robustly extract cosmological information"
header:
  teaser: /assets/img/aicosmo.png
importance: 3
excerpt: ""
---

Traditional cosmological analyses rely on compressing observational data into summary statistics --- most commonly the two-point correlation function or power spectrum. While this approach is optimal for Gaussian random fields, the nonlinear gravitational evolution of cosmic structure introduces significant non-Gaussianity on small scales. This means that summary statistics inevitably discard cosmological information, particularly about parameters like the neutrino mass and the equation of state of dark energy that leave their strongest signatures in the nonlinear regime. My work develops methods that go beyond these limitations to optimally and robustly extract cosmological information.

### Field-Level BAO Reconstruction

Baryon acoustic oscillations (BAO) are one of the most powerful probes in cosmology --- a standard ruler imprinted in the distribution of matter by sound waves in the early Universe. Measuring the BAO scale with high precision is critical for constraining the expansion history of the Universe and the nature of dark energy. I have developed <a href="https://doi.org/10.48550/arXiv.2603.15732">field-level inference methods for BAO reconstruction</a>, first reconstructing the initial linear density field and then fitting the BAO signal therein. By benchmarking traditional reconstruction against explicit field-level inference using differentiable forward modeling with hybrid effective field theory, as well as implicit field-level inference using convolutional neural networks, we show that field-level approaches significantly sharpen the BAO feature relative to traditional reconstruction on DESI-like galaxy catalogs. This is an exciting result because it demonstrates that field-level methods can meaningfully improve constraints on the expansion history of the Universe from existing and upcoming surveys.

### Field-Level Inference

Instead of compressing the data, field-level inference performs inference directly on the full three-dimensional matter field. By forward-modeling the evolution of the Universe from initial conditions to the observed field and comparing the result to data, we can in principle extract all of the available cosmological information --- not just the fraction captured by summary statistics.

Sampling the posterior distribution over initial conditions of the Universe is an extraordinarily high-dimensional problem --- the number of parameters equals the number of voxels in the volume being analyzed, often in the millions. I have worked on applying <a href="https://doi.org/10.48550/arXiv.2307.09504">Microcanonical Langevin Monte Carlo (MCLMC)</a> to this problem. MCLMC is a gradient-based sampling algorithm that is particularly well-suited to high-dimensional spaces, achieving over an order of magnitude greater efficiency than traditional Hamiltonian Monte Carlo. This enables efficient exploration of the posterior over initial conditions and, in turn, tight constraints on cosmological parameters from the full field.

### Robustness of Field-Level Inference

Extracting maximal information from cosmological data is only meaningful if the results are robust. A critical question is whether the simulations used to train or calibrate inference pipelines introduce systematic biases. I have conducted the first <a href="https://doi.org/10.48550/arXiv.2505.13620">field-level comparison and robustness analysis of cosmological N-body simulations</a>, evaluating widely used codes including Abacus, Gadget, and others. We find that differences between simulation codes --- particularly between adaptive mesh refinement (AMR) and non-AMR methods --- can introduce biases larger than those from hydrodynamic effects, and that even resolution differences within the same code lead to biased inference. These findings motivate the need for careful data filtering and the use of field-level out-of-distribution metrics to ensure robust cosmological constraints.

### Simulation-Based Inference

A key challenge is that the likelihood of the full field is intractable --- we cannot write down an analytic expression for the probability of observing a given configuration of galaxies. Simulation-based inference (SBI) circumvents this by using simulations as an implicit likelihood. Rather than evaluating the likelihood directly, SBI methods learn the mapping from simulated data to posterior distributions over cosmological parameters using neural networks. I have contributed to developing <a href="https://doi.org/10.48550/arXiv.2402.05137">SBI benchmarks</a> for upcoming surveys like LSST, establishing the accuracy and reliability of these methods for real-world cosmological analysis.

### Neural Networks for Neutrino Mass

Standard analyses compress the rich information in weak lensing maps into the power spectrum. However, in the nonlinear regime, significant information is encoded in the higher-order structure of the fields. I have developed <a href="https://doi.org/10.48550/arXiv.2406.03076">convolutional neural network (CNN) architectures</a> that operate directly on weak lensing convergence maps to constrain the neutrino mass. By learning to extract non-Gaussian features that are invisible to two-point statistics, these networks can substantially tighten neutrino mass constraints beyond what is achievable with traditional methods.

### Velocity Reconstruction

Galaxy peculiar velocities contain a wealth of cosmological information that is complementary to galaxy positions alone. I have developed methods for <a href="https://doi.org/10.48550/arXiv.2210.15657">joint velocity and density reconstruction</a>, combining galaxy clustering and peculiar velocity data to tighten constraints on cosmological parameters. Peculiar velocities are particularly powerful for breaking degeneracies between parameters like the growth rate of structure and the amplitude of matter fluctuations.

These methods --- field-level inference, simulation-based inference, machine learning, and multi-probe reconstruction --- represent the frontier of cosmological data analysis and are critical for fully exploiting the enormous datasets arriving from the next generation of surveys.
