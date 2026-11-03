; benchmark generated from python API
(set-info :status unknown)
(declare-fun q_limit () Int)
(declare-fun q_used () Int)
(declare-fun q_claimed () Bool)
(assert
 (let (($x790 (>= q_used 0)))
 (let (($x491 (> q_limit 0)))
 (and $x491 $x790 (<= q_used q_limit)))))
(assert
 (let ((?x889 (ite (and q_claimed (< q_used q_limit)) (+ q_used 1) q_used)))
(let (($x491 (> q_limit 0)))
(let (($x783 (and $x491 (>= ?x889 0) (<= ?x889 q_limit))))
(not $x783)))))
(check-sat)
