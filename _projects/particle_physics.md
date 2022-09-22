---
layout: page
title: Particle Physics
description: I once helped build particle detectors
img: assets/img/neutrino_detector.jpg
importance: 5
category: work
---


You can also put regular text between your rows of images.
Say you wanted to write a little bit about your project before you posted the rest of the images.
You describe how you toiled, sweated, *bled* for your project, and then... you reveal it's glory in the next row of images.


<div class="row justify-content-sm-center">
    <div class="col-sm-8 mt-3 mt-md-0">
        {% include figure.html path="assets/img/150813_urop_bayer_araujo_001_178131_001.jpg" title="example image" class="img-fluid rounded z-depth-1" %}
    </div>
    <!--><div class="col-sm-4 mt-3 mt-md-0">
        {% include figure.html path="assets/img/pmt1.jpg" title="example image" class="img-fluid rounded z-depth-1" %}
    </div>-->
</div>
<div class="caption">
    (Left) ...  (Right) 
</div>


The code is simple.
Just wrap your images with `<div class="col-sm">` and place them inside `<div class="row">` (read more about the <a href="https://getbootstrap.com/docs/4.4/layout/grid/">Bootstrap Grid</a> system).
To make images responsive, add `img-fluid` class to each; for rounded corners and shadows use `rounded` and `z-depth-1` classes.
Here's the code for the last row of images above:

