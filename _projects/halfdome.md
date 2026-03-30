---
layout: single
title: "HalfDome: Multi-Survey Simulations"
description: "Building a large suite of N-body simulations for joint analysis of CMB and galaxy surveys"
header:
  teaser: /assets/img/halfdome_skymap.png
importance: 2
excerpt: ""
---

A central challenge in modern cosmology is that no single observation can fully constrain the properties of our Universe. Galaxy surveys, cosmic microwave background (CMB) experiments, and weak lensing measurements each capture different aspects of cosmic structure, but they are all observing the same underlying Universe. To maximize the science return of upcoming surveys such as the Rubin Observatory's Legacy Survey of Space and Time (LSST), CMB-S4, and DESI, we need to understand the correlations between these different observational probes.

<a href="https://halfdomesims.github.io">HalfDome</a> is a large suite of multi-survey cosmological N-body simulations that I am co-developing to address this need. These simulations self-consistently model the observables relevant to multiple cosmological surveys, enabling the study of cross-correlations between CMB lensing, galaxy clustering, weak lensing, and other probes. By simulating all of these observables from the same underlying matter distribution, HalfDome captures the covariances and cross-correlations that are essential for joint analyses but impossible to model analytically in the nonlinear regime.

The simulations are designed to support the development of joint analysis pipelines that combine data across surveys. Cross-correlations between different probes can break parameter degeneracies, mitigate systematic effects, and ultimately yield tighter constraints on fundamental physics --- including the neutrino mass, the nature of dark energy, and the amplitude of matter fluctuations. HalfDome is a key part of the effort to ensure that the cosmology community is prepared to fully exploit the wealth of data arriving from the next generation of surveys.

For more details, see the <a href="https://doi.org/10.48550/arXiv.2407.17462">HalfDome paper</a> or visit the <a href="https://halfdomesims.github.io">project website</a>.
