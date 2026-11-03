; benchmark generated from python API
(set-info :status unknown)
(declare-fun t_window () Real)
(declare-fun t_recorded () Real)
(declare-fun t_now () Real)
(declare-fun t_step () Real)
(assert
 (> t_window 0.0))
(assert
 (>= t_recorded 0.0))
(assert
 (let ((?x663 (- t_now t_recorded)))
 (>= ?x663 t_window)))
(assert
 (> t_step 0.0))
(assert
 (let ((?x663 (- t_now t_recorded)))
(let (($x140 (< ?x663 t_window)))
(let (($x540 (not $x140)))
(not $x540)))))
(check-sat)
